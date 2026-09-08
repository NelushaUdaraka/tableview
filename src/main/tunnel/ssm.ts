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
import { isLoopbackHost } from '../../shared/hosts'
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
 * The plugin's own announcement that the local listener is bound.
 *
 * Trusting it beats probing the port: `AWS-StartPortForwardingSession` carries
 * one client at a time, and a probe that connects and hangs up tears the far
 * side down for the connection that follows.
 */
const READY_BANNER = /port \d+ opened for sessionid|waiting for connections/i

/**
 * Session Manager opens the local port before anything is dialled at the far
 * end, so an unreachable destination only shows up once traffic flows: the
 * plugin accepts the socket, fails to reach the target, and closes it again.
 * These are the phrases it and the agent use when that happens.
 */
const DESTINATION_UNREACHABLE =
  /connection to destination port failed|unable to dial connection to (?:port|server)|failed to establish connection to destination/i

/**
 * What to do about a destination the session could not reach.
 *
 * The two topologies fail for entirely different reasons, so the advice names
 * the one actually in use rather than listing both.
 */
export function describeSsmDestination(config: SsmConfig, target: TunnelTarget): string {
  const instance = config.instanceId?.trim() || 'the bastion'
  if (config.mode === 'remote-host') {
    // A relayed address is resolved by the bastion, so a loopback one names the
    // bastion itself — the setting looks right and quietly forwards nowhere.
    if (isLoopbackHost(target.host)) {
      return `Server is "${target.host}", which is resolved from ${instance} — so this dialled port ${target.port} on the bastion itself, not a database elsewhere. Put the database's own address in Server (an RDS endpoint, say), or switch "Forward to" to the instance if SQL Server really does run on the bastion.`
    }
    return `The session reached ${instance}, but it could not reach ${target.host}:${target.port} from there. Check that the database's security group allows the bastion, that the name resolves from it, and that the server is listening on that port.`
  }
  return `The session reached ${instance}, but nothing is listening on port ${target.port} of the instance itself. "Forward to" is set to the instance, so that port was dialled on the bastion — if SQL Server actually runs elsewhere (an RDS endpoint, say), set "Forward to" to a remote host and put its address in Server.`
}

/**
 * Classifies a failure the CLI reports while the session is still running.
 *
 * The exit-time classifier never sees these: the session survives a destination
 * it cannot reach, so the process stays alive and only the forwarded socket
 * dies. Left unclassified, the driver's "socket hang up" is all the user gets.
 */
export function classifySsmRuntimeFailure(
  output: string,
  destinationAdvice: string
): string | null {
  return DESTINATION_UNREACHABLE.test(output) ? destinationAdvice : null
}

/**
 * Turns the CLI's output into something a user can act on.
 *
 * These messages are the whole point of the feature — an unclassified
 * "command failed with exit code 254" sends people back to the terminal.
 */
export function classifySsmFailure(
  output: string,
  exitCode: number | null,
  /** Advice for a destination the session could not reach, when known. */
  destinationAdvice?: string
): string {
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
  if (DESTINATION_UNREACHABLE.test(text)) {
    return (
      destinationAdvice ??
      'The session started, but the port could not be reached at the far end. Check that the server is listening and that the bastion can reach it.'
    )
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

  /**
   * The driver and the CLI report the same failure over different channels, and
   * the socket closes first. Poll briefly so the CLI's explanation wins the race
   * instead of a bare "socket hang up".
   */
  async waitForForwardError(timeoutMs: number): Promise<Error | null> {
    const deadline = Date.now() + timeoutMs
    while (!this.forwardError && !this.closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return this.forwardError
  }

  /**
   * Session Manager binds the local port before dialling anything, so a dead
   * destination is indistinguishable from a healthy session until the first
   * byte moves. That makes this the likeliest reading of a dropped connection
   * the CLI said nothing about.
   */
  get droppedConnectionHint(): string {
    return describeSsmDestination(this.config, this.target)
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
      const text = chunk.toString()
      this.output += text
      // Keep the buffer bounded; the tail is what matters for diagnostics.
      if (this.output.length > 64_000) this.output = this.output.slice(-32_000)

      // A session that cannot reach its destination keeps running and says so
      // here rather than exiting, so the exit handler alone would miss it.
      // Classify per chunk: the accumulated buffer would re-match forever.
      if (!this.forwardError && !this.closed) {
        const runtime = classifySsmRuntimeFailure(text, this.droppedConnectionHint)
        if (runtime) this.forwardError = new Error(runtime)
      }
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
        this.forwardError = new Error(
          classifySsmFailure(this.output, code, this.droppedConnectionHint)
        )
      }
    })

    try {
      await waitForPort(
        localPort,
        '127.0.0.1',
        this.config.startTimeoutMs ?? 30000,
        // Stop waiting the moment the CLI gives up, instead of burning the
        // whole timeout on a process that has already failed.
        () =>
          this.exited
            ? classifySsmFailure(this.output, this.exited.code, this.droppedConnectionHint)
            : null,
        // The plugin says when the listener is up; take its word for it rather
        // than spending a connection on a session that carries one at a time.
        () => READY_BANNER.test(this.output)
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
