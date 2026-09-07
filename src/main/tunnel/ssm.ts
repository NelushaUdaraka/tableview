/**
 * AWS Systems Manager Session Manager port forwarding.
 *
 * Runs the same `aws ssm start-session` command you would type by hand, but as
 * a managed child process tied to the connection's lifetime: it opens on
 * connect, the driver dials the loopback port it allocated, and it is torn down
 * on disconnect.
 *
 * Two topologies are supported:
 *   - `remote-host` — the bastion relays to another host (RDS, an internal
 *     listener). Uses AWS-StartPortForwardingSessionToRemoteHost.
 *   - `instance`    — SQL Server runs on the target instance itself. Uses
 *     AWS-StartPortForwardingSession.
 */
import { ChildProcess, spawn } from 'node:child_process'
import type { SsmConfig } from '../../shared/types'
import { Tunnel, TunnelHandle, TunnelTarget, findFreePort, waitForPort } from './types'

export const SSM_DOCUMENT_REMOTE_HOST = 'AWS-StartPortForwardingSessionToRemoteHost'
export const SSM_DOCUMENT_INSTANCE = 'AWS-StartPortForwardingSession'

export class SsmTunnelError extends Error {
  constructor(
    message: string,
    /** What the AWS CLI actually printed, for the details pane. */
    readonly detail?: string
  ) {
    super(message)
    this.name = 'SsmTunnelError'
  }
}

export interface SsmCommand {
  command: string
  args: string[]
  env: Record<string, string | undefined>
}

const INSTANCE_ID = /^(i-[0-9a-f]{8,17}|mi-[0-9a-f]{8,17})$/i

/**
 * Builds the CLI invocation.
 *
 * `--parameters` is passed as one JSON argv element and the process is spawned
 * without a shell, so hosts containing characters a shell would mangle are safe.
 */
export function buildSsmCommand(
  config: SsmConfig,
  target: TunnelTarget,
  localPort: number
): SsmCommand {
  if (!config.instanceId?.trim()) {
    throw new SsmTunnelError('An EC2 instance ID is required for an SSM session')
  }
  if (!INSTANCE_ID.test(config.instanceId.trim())) {
    throw new SsmTunnelError(
      `"${config.instanceId}" does not look like an instance ID — expected something like i-0123456789abcdef0`
    )
  }
  if (config.mode === 'remote-host' && !target.host?.trim()) {
    throw new SsmTunnelError(
      'A database host is required — it is resolved from the bastion, so use the address the instance can reach'
    )
  }

  const parameters =
    config.mode === 'remote-host'
      ? {
          host: [target.host.trim()],
          portNumber: [String(target.port)],
          localPortNumber: [String(localPort)]
        }
      : {
          portNumber: [String(target.port)],
          localPortNumber: [String(localPort)]
        }

  const args = [
    'ssm',
    'start-session',
    '--target',
    config.instanceId.trim(),
    '--document-name',
    config.mode === 'remote-host' ? SSM_DOCUMENT_REMOTE_HOST : SSM_DOCUMENT_INSTANCE,
    '--parameters',
    JSON.stringify(parameters)
  ]

  // A pasted block carries its own identity; --profile would override it.
  if (config.credentialSource !== 'pasted' && config.profile?.trim()) {
    args.push('--profile', config.profile.trim())
  }
  if (config.region?.trim()) args.push('--region', config.region.trim())

  return {
    command: config.awsCliPath?.trim() || 'aws',
    args,
    // The CLI is chatty and paginates by default; neither helps a child process.
    env: { AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' }
  }
}

/**
 * Turns the CLI's output into something a user can act on.
 *
 * These messages are the whole point of the feature — an unclassified
 * "command failed with exit code 254" sends people back to the terminal.
 */
export function classifySsmFailure(output: string, exitCode: number | null): string {
  const text = output.toLowerCase()

  if (/sessionmanagerplugin is not found|session-manager-plugin.*not found/.test(text)) {
    return 'The Session Manager plugin is not installed. Install it from AWS docs ("Install the Session Manager plugin for the AWS CLI"), then reopen this connection.'
  }
  if (/enoent|is not recognized as an internal|command not found/.test(text)) {
    return 'The AWS CLI was not found. Install AWS CLI v2, or set an explicit path in the connection settings.'
  }
  if (/targetnotconnected/.test(text)) {
    return 'The instance is not connected to Systems Manager. Check that the SSM Agent is running on it and that its instance profile allows SSM.'
  }
  if (/invalidinstanceid|instance id.*not valid/.test(text)) {
    return 'Systems Manager does not recognise that instance ID in this account and region. Check the ID, the region and the profile.'
  }
  if (/accessdenied|not authorized|user.*is not authorized/.test(text)) {
    return 'Access denied by IAM. The identity needs ssm:StartSession on the instance and on the port-forwarding document.'
  }
  if (/expired|token has expired|refresh.*credentials|sso session associated/.test(text)) {
    return 'Your AWS credentials have expired. Refresh them (for SSO: aws sso login --profile <name>) and try again.'
  }
  if (/unable to locate credentials|no credentials/.test(text)) {
    return 'No AWS credentials were found for that profile. Check the profile name, or configure credentials for the default profile.'
  }
  if (/could not connect to the endpoint|endpoint url|network is unreachable|timed out/.test(text)) {
    return 'Could not reach the AWS Systems Manager endpoint. Check network access and the configured region.'
  }
  if (/address already in use|bind.*in use/.test(text)) {
    return 'The local port is already in use. Use automatic port selection, or pick a different port.'
  }
  if (/profile.*not found|the config profile.*could not be found/.test(text)) {
    return 'That AWS profile does not exist in your AWS config.'
  }

  const trimmed = output.trim().split('\n').filter(Boolean).slice(-3).join(' ')
  return trimmed
    ? `The AWS CLI exited with code ${exitCode ?? 'unknown'}: ${trimmed}`
    : `The AWS CLI exited with code ${exitCode ?? 'unknown'} without explaining why.`
}

export class SsmTunnel implements Tunnel {
  private child: ChildProcess | null = null
  private output = ''
  private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private closed = false
  private forwardError: Error | null = null

  constructor(
    private readonly config: SsmConfig,
    private readonly target: TunnelTarget,
    /**
     * Credentials to hand the CLI, for the "pasted" source. Undefined lets the
     * CLI resolve them itself from the inherited environment and AWS config.
     */
    private readonly credentialEnv?: Record<string, string>,
    /** Injected so tests can drive a stand-in for the AWS CLI. */
    private readonly spawnFn: typeof spawn = spawn
  ) {}

  get lastForwardError(): Error | null {
    return this.forwardError
  }

  /** Everything the CLI printed, for surfacing in the UI on failure. */
  get cliOutput(): string {
    return this.output
  }

  async open(): Promise<TunnelHandle> {
    const localPort =
      this.config.localPort && this.config.localPort > 0
        ? this.config.localPort
        : await findFreePort()

    const { command, args, env } = buildSsmCommand(this.config, this.target, localPort)

    const child = this.spawnFn(command, args, {
      // Pasted credentials win over anything inherited, so a stale AWS_PROFILE
      // in the app's environment cannot quietly take precedence.
      env: { ...process.env, ...env, ...(this.credentialEnv ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // No shell: the JSON parameter travels as a single argv element, so
      // nothing has to be quoted for cmd.exe or sh.
      shell: false,
      windowsHide: true
    })
    this.child = child

    const record = (chunk: Buffer): void => {
      this.output += chunk.toString()
      // Keep the buffer bounded; the tail is what matters for diagnostics.
      if (this.output.length > 64_000) this.output = this.output.slice(-32_000)
    }
    child.stdout?.on('data', record)
    child.stderr?.on('data', record)

    child.once('error', (error) => {
      this.output += `\n${error.message}`
      this.exited = { code: null, signal: null }
    })
    child.once('exit', (code, signal) => {
      this.exited = { code, signal }
      if (!this.closed && !this.forwardError) {
        this.forwardError = new Error(classifySsmFailure(this.output, code))
      }
    })

    try {
      await waitForPort(
        localPort,
        '127.0.0.1',
        this.config.startTimeoutMs ?? 30000,
        // Stop waiting the moment the CLI gives up, instead of burning the
        // whole timeout on a process that has already failed.
        () => (this.exited ? classifySsmFailure(this.output, this.exited.code) : null)
      )
    } catch (error) {
      await this.close()
      const message = error instanceof Error ? error.message : String(error)
      throw new SsmTunnelError(message, this.output.trim() || undefined)
    }

    return {
      localHost: '127.0.0.1',
      localPort,
      close: () => this.close()
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.signalCode !== null) return

    // The CLI spawns session-manager-plugin as a grandchild. On POSIX a SIGTERM
    // to the CLI is relayed and the session is terminated cleanly; on Windows
    // there is no such relay, so the whole tree has to be taken down or the
    // plugin keeps holding the local port.
    if (process.platform === 'win32' && child.pid !== undefined) {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.once('exit', () => resolve())
        killer.once('error', () => {
          child.kill('SIGKILL')
          resolve()
        })
      })
      return
    }

    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
