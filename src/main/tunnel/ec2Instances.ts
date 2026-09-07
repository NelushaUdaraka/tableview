/**
 * Lists the instances an SSM session could target.
 *
 * A bastion's instance ID is not a stable value: it changes every time the
 * instance is replaced — a new AMI, a scaling event, the next deployment — so
 * an ID typed into a saved connection goes stale on its own. This asks the
 * account instead, and the connection form turns the answer into a picker.
 *
 * Two calls, because neither one alone tells the whole story:
 *   - `ec2 describe-instances`            — what exists, with Name tags and state.
 *   - `ssm describe-instance-information` — what Systems Manager can reach, which
 *     is the part that decides whether `start-session` will work at all, and
 *     which also covers `mi-` managed instances that are not EC2.
 *
 * Either call may be denied by IAM without the other being denied, so a
 * failure on one side degrades to a list from the other plus a warning.
 */
import { execFile } from 'node:child_process'
import type { SsmConfig } from '../../shared/types'
import type { SsmInstance, SsmInstanceList } from '../../shared/ipc'

export class InstanceLookupError extends Error {
  constructor(
    message: string,
    /** What the AWS CLI actually printed, for the details pane. */
    readonly detail?: string
  ) {
    super(message)
    this.name = 'InstanceLookupError'
  }
}

/** A bound on a very large account, rather than a limit anyone should hit. */
const MAX_ITEMS = 500

/** Terminated instances are noise — they cannot be a bastion again. */
const LIVE_STATES = 'pending,running,shutting-down,stopping,stopped'

export interface CliRun {
  code: number | null
  stdout: string
  stderr: string
}

/** Injected so tests can answer for the AWS CLI without spawning one. */
export type CliRunner = (
  command: string,
  args: string[],
  env: Record<string, string>
) => Promise<CliRun>

export interface CliInvocation {
  command: string
  args: string[]
}

/** The two lookups, named for the IAM action each one needs. */
export type LookupKind = 'ec2' | 'ssm'

const IAM_ACTION: Record<LookupKind, string> = {
  ec2: 'ec2:DescribeInstances',
  ssm: 'ssm:DescribeInstanceInformation'
}

/**
 * Builds one CLI invocation.
 *
 * Region is passed explicitly rather than read from the config, because it may
 * have come from the pasted credential block instead of the region field.
 */
export function buildInstanceListCommand(
  config: SsmConfig,
  kind: LookupKind,
  region?: string
): CliInvocation {
  const args =
    kind === 'ec2'
      ? [
          'ec2',
          'describe-instances',
          '--filters',
          `Name=instance-state-name,Values=${LIVE_STATES}`
        ]
      : ['ssm', 'describe-instance-information']

  args.push('--max-items', String(MAX_ITEMS), '--output', 'json')

  // A pasted block carries its own identity; --profile would override it.
  if (config.credentialSource !== 'pasted' && config.profile?.trim()) {
    args.push('--profile', config.profile.trim())
  }
  if (region?.trim()) args.push('--region', region.trim())

  return { command: config.awsCliPath?.trim() || 'aws', args }
}

/** The region the lookup should run in: the field first, then the credentials. */
export function resolveRegion(
  config: SsmConfig,
  credentialEnv: Record<string, string> = {}
): string | undefined {
  return (
    config.region?.trim() ||
    credentialEnv.AWS_REGION?.trim() ||
    credentialEnv.AWS_DEFAULT_REGION?.trim() ||
    undefined
  )
}

// -- response shapes --------------------------------------------------------

interface DescribeInstancesResponse {
  Reservations?: {
    Instances?: {
      InstanceId?: string
      InstanceType?: string
      State?: { Name?: string }
      PrivateIpAddress?: string
      PublicIpAddress?: string
      Placement?: { AvailabilityZone?: string }
      VpcId?: string
      Platform?: string
      PlatformDetails?: string
      LaunchTime?: string
      Tags?: { Key?: string; Value?: string }[]
    }[]
  }[]
  NextToken?: string
}

interface InstanceInformationResponse {
  InstanceInformationList?: {
    InstanceId?: string
    PingStatus?: string
    PlatformName?: string
    PlatformType?: string
    ComputerName?: string
    IPAddress?: string
    Name?: string
    ResourceType?: string
  }[]
  NextToken?: string
}

function parseJson<T>(text: string, kind: LookupKind): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new InstanceLookupError(
      `The AWS CLI did not return readable JSON for the ${kind === 'ec2' ? 'EC2' : 'Systems Manager'} lookup.`,
      text.trim().slice(0, 500) || undefined
    )
  }
}

/** Flattens the reservation nesting into plain instances. */
export function parseDescribeInstances(text: string): { instances: SsmInstance[]; truncated: boolean } {
  const parsed = parseJson<DescribeInstancesResponse>(text, 'ec2')
  const instances: SsmInstance[] = []

  for (const reservation of parsed.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      if (!instance.InstanceId) continue
      const name = instance.Tags?.find((tag) => tag.Key === 'Name')?.Value?.trim()
      instances.push({
        instanceId: instance.InstanceId,
        name: name || undefined,
        state: instance.State?.Name ?? 'unknown',
        instanceType: instance.InstanceType,
        privateIpAddress: instance.PrivateIpAddress,
        publicIpAddress: instance.PublicIpAddress,
        availabilityZone: instance.Placement?.AvailabilityZone,
        vpcId: instance.VpcId,
        // `Platform` is only present for Windows; `PlatformDetails` covers the rest.
        platform: instance.PlatformDetails ?? instance.Platform,
        launchTime: instance.LaunchTime,
        ssmManaged: false
      })
    }
  }

  return { instances, truncated: Boolean(parsed.NextToken) }
}

/** The Systems Manager view, keyed by instance ID. */
export function parseInstanceInformation(text: string): {
  managed: Map<string, SsmInstance>
  truncated: boolean
} {
  const parsed = parseJson<InstanceInformationResponse>(text, 'ssm')
  const managed = new Map<string, SsmInstance>()

  for (const entry of parsed.InstanceInformationList ?? []) {
    if (!entry.InstanceId) continue
    const name = (entry.Name || entry.ComputerName || '').trim()
    managed.set(entry.InstanceId, {
      instanceId: entry.InstanceId,
      name: name || undefined,
      state: 'unknown',
      privateIpAddress: entry.IPAddress,
      platform: entry.PlatformName,
      ssmManaged: true,
      ssmPingStatus: entry.PingStatus
    })
  }

  return { managed, truncated: Boolean(parsed.NextToken) }
}

/**
 * Combines the two views.
 *
 * EC2 wins on the descriptive fields it has (Name tag, state, type); Systems
 * Manager contributes reachability, and anything it knows about that EC2 did
 * not report — an `mi-` managed instance, say — is appended rather than lost.
 */
export function mergeInstances(
  ec2: SsmInstance[],
  managed: Map<string, SsmInstance>
): SsmInstance[] {
  const merged = ec2.map((instance) => {
    const info = managed.get(instance.instanceId)
    if (!info) return instance
    return {
      ...instance,
      ssmManaged: true,
      ssmPingStatus: info.ssmPingStatus,
      name: instance.name ?? info.name,
      privateIpAddress: instance.privateIpAddress ?? info.privateIpAddress,
      platform: instance.platform ?? info.platform
    }
  })

  const seen = new Set(ec2.map((instance) => instance.instanceId))
  for (const [id, info] of managed) {
    if (!seen.has(id)) merged.push(info)
  }

  return sortInstances(merged)
}

/** The ones that can actually carry a session first, so the list opens useful. */
export function sortInstances(instances: SsmInstance[]): SsmInstance[] {
  const rank = (instance: SsmInstance): number => {
    if (instance.ssmManaged && instance.ssmPingStatus === 'Online') return 0
    if (instance.ssmManaged) return 1
    if (instance.state === 'running') return 2
    return 3
  }

  return [...instances].sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    // Named instances before anonymous ones, then alphabetically, then by ID.
    const byNamed = Number(Boolean(b.name)) - Number(Boolean(a.name))
    if (byNamed !== 0) return byNamed
    const byName = (a.name ?? '').localeCompare(b.name ?? '')
    return byName !== 0 ? byName : a.instanceId.localeCompare(b.instanceId)
  })
}

/**
 * Turns a failed lookup into an instruction.
 *
 * The IAM message names the action that was actually denied, because the two
 * lookups need different permissions and "access denied" on its own sends
 * people to the wrong policy.
 */
export function classifyInstanceLookupFailure(
  output: string,
  exitCode: number | null,
  kind: LookupKind
): string {
  const text = output.toLowerCase()

  if (/enoent|is not recognized as an internal|command not found|no such file/.test(text)) {
    return 'The AWS CLI was not found. Install AWS CLI v2, or set an explicit path in the connection settings.'
  }
  if (/expired|token has expired|refresh.*credentials|sso session associated/.test(text)) {
    return 'Your AWS credentials have expired. Paste a fresh block from the access portal (or for SSO run: aws sso login --profile <name>).'
  }
  if (/unable to locate credentials|no credentials|missing credentials/.test(text)) {
    return 'No AWS credentials were found. Paste a block from the access portal, or pick a profile the CLI can resolve.'
  }
  if (/accessdenied|unauthorizedoperation|not authorized|you are not authorized/.test(text)) {
    return `Access denied by IAM. The identity needs ${IAM_ACTION[kind]} in this region.`
  }
  if (/you must specify a region|region.*not.*specified|invalid.*region|could not connect to the endpoint/.test(text)) {
    return 'That region could not be reached. Choose the region the bastion runs in — instances are listed one region at a time.'
  }
  if (/profile.*not found|the config profile.*could not be found/.test(text)) {
    return 'That AWS profile does not exist in your AWS config.'
  }
  if (/network is unreachable|timed out|connection.*refused/.test(text)) {
    return 'Could not reach the AWS API. Check network access and any proxy settings.'
  }

  const trimmed = output.trim().split('\n').filter(Boolean).slice(-3).join(' ')
  return trimmed
    ? `The AWS CLI exited with code ${exitCode ?? 'unknown'}: ${trimmed}`
    : `The AWS CLI exited with code ${exitCode ?? 'unknown'} without explaining why.`
}

/** Spawns the CLI, capturing enough output for a large account. */
const runCli: CliRunner = (command, args, env) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: 30000,
        windowsHide: true,
        // describe-instances is verbose; the default 1 MB truncates real accounts.
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', ...env }
      },
      (error, stdout, stderr) => {
        const errno = error as (NodeJS.ErrnoException & { code?: number | string }) | null
        const code =
          errno && typeof errno.code === 'number' ? errno.code : error ? null : 0
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') + (error && code === null ? `\n${error.message}` : '')
        })
      }
    )
  })

/**
 * Lists the instances in the configured region.
 *
 * Throws only when nothing at all could be read; a partial answer comes back
 * as a list plus a `warning`, because a denial on one of the two calls still
 * leaves a usable picker.
 */
export async function listSsmInstances(
  config: SsmConfig,
  credentialEnv: Record<string, string> = {},
  run: CliRunner = runCli
): Promise<SsmInstanceList> {
  const region = resolveRegion(config, credentialEnv)
  // With pasted credentials there is no profile to fall back on, so a missing
  // region is a question for the user rather than an error from the CLI.
  if (!region && config.credentialSource === 'pasted') {
    throw new InstanceLookupError(
      'Choose an AWS region first — instances are listed one region at a time.'
    )
  }

  const lookup = async (kind: LookupKind): Promise<{ result?: CliRun; error?: string }> => {
    const { command, args } = buildInstanceListCommand(config, kind, region)
    const result = await run(command, args, credentialEnv)
    if (result.code === 0) return { result }
    return {
      error: classifyInstanceLookupFailure(`${result.stderr} ${result.stdout}`, result.code, kind)
    }
  }

  const [ec2, ssm] = await Promise.all([lookup('ec2'), lookup('ssm')])

  let described: { instances: SsmInstance[]; truncated: boolean } = {
    instances: [],
    truncated: false
  }
  let information: { managed: Map<string, SsmInstance>; truncated: boolean } = {
    managed: new Map(),
    truncated: false
  }
  let ec2Error = ec2.error
  let ssmError = ssm.error

  // A response that cannot be read counts as that side having failed, so one
  // unreadable answer never costs the list the other side produced.
  if (ec2.result) {
    try {
      described = parseDescribeInstances(ec2.result.stdout)
    } catch (error) {
      ec2Error = error instanceof Error ? error.message : String(error)
    }
  }
  if (ssm.result) {
    try {
      information = parseInstanceInformation(ssm.result.stdout)
    } catch (error) {
      ssmError = error instanceof Error ? error.message : String(error)
    }
  }

  if (ec2Error && ssmError) {
    // The EC2 message is the more likely cause of the two, and a shared cause
    // (expired credentials) produces the same text on both sides anyway.
    throw new InstanceLookupError(ec2Error)
  }

  const warnings: string[] = []
  if (ec2Error) warnings.push(`Only Systems Manager could be listed — ${ec2Error}`)
  if (ssmError) warnings.push(`Reachability is unknown — ${ssmError}`)
  if (described.truncated || information.truncated) {
    warnings.push(`The list was cut short at the first ${MAX_ITEMS} results.`)
  }

  return {
    region,
    instances: mergeInstances(described.instances, information.managed),
    warning: warnings.length ? warnings.join(' ') : undefined
  }
}
