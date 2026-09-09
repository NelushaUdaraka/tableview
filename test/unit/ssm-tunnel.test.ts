/**
 * Exercises the SSM tunnel end to end against a stand-in for the AWS CLI
 * (`test/fixtures/fake-aws.mjs`), so the spawn, readiness, data path, teardown
 * and every failure branch are covered without an AWS account.
 */
import net from 'node:net'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SSM_DOCUMENT_INSTANCE,
  SSM_DOCUMENT_REMOTE_HOST,
  SsmTunnel,
  SsmTunnelError,
  buildSsmCommand,
  classifySsmFailure,
  classifySsmRuntimeFailure,
  describeSsmDestination,
  isExpiredCredentialsFailure
} from '../../src/main/tunnel/ssm'
import {
  DEFAULT_SSM_CONFIG,
  SSM_CREDENTIALS_EXPIRED,
  type SsmConfig
} from '../../src/shared/types'
import { findFreePort } from '../../src/main/tunnel/types'

const FAKE_CLI = join(__dirname, '../fixtures/fake-aws.mjs')

function config(overrides: Partial<SsmConfig> = {}): SsmConfig {
  return {
    ...DEFAULT_SSM_CONFIG,
    enabled: true,
    instanceId: 'i-0123456789abcdef0',
    mode: 'remote-host',
    ...overrides
  }
}

describe('buildSsmCommand', () => {
  it('builds a remote-host forward', () => {
    const built = buildSsmCommand(config(), { host: 'db.internal', port: 1433 }, 55001)
    expect(built.command).toBe('aws')
    expect(built.args.slice(0, 6)).toEqual([
      'ssm',
      'start-session',
      '--target',
      'i-0123456789abcdef0',
      '--document-name',
      SSM_DOCUMENT_REMOTE_HOST
    ])
    expect(JSON.parse(built.args[built.args.indexOf('--parameters') + 1])).toEqual({
      host: ['db.internal'],
      portNumber: ['1433'],
      localPortNumber: ['55001']
    })
  })

  it('omits the host when forwarding to a port on the instance itself', () => {
    const built = buildSsmCommand(config({ mode: 'instance' }), { host: 'ignored', port: 1433 }, 55002)
    expect(built.args[5]).toBe(SSM_DOCUMENT_INSTANCE)
    const parameters = JSON.parse(built.args[built.args.indexOf('--parameters') + 1])
    expect(parameters).toEqual({ portNumber: ['1433'], localPortNumber: ['55002'] })
    expect(parameters.host).toBeUndefined()
  })

  it('adds profile and region only when set', () => {
    const withBoth = buildSsmCommand(
      config({ credentialSource: 'cli', profile: 'prod', region: 'eu-west-1' }),
      { host: 'db', port: 1433 },
      1
    )
    expect(withBoth.args).toContain('--profile')
    expect(withBoth.args).toContain('prod')
    expect(withBoth.args).toContain('--region')
    expect(withBoth.args).toContain('eu-west-1')

    const withNeither = buildSsmCommand(
      config({ credentialSource: 'cli' }),
      { host: 'db', port: 1433 },
      1
    )
    expect(withNeither.args).not.toContain('--profile')
    expect(withNeither.args).not.toContain('--region')
  })

  it('omits --profile for pasted credentials, which carry their own identity', () => {
    const built = buildSsmCommand(
      config({ credentialSource: 'pasted', profile: 'prod', region: 'eu-west-1' }),
      { host: 'db', port: 1433 },
      1
    )
    expect(built.args).not.toContain('--profile')
    // The region is still a plain routing hint, so it stays.
    expect(built.args).toContain('--region')
  })

  it('honours an explicit CLI path', () => {
    const built = buildSsmCommand(
      config({ awsCliPath: 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe' }),
      { host: 'db', port: 1433 },
      1
    )
    expect(built.command).toBe('C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe')
  })

  it('silences the pager and auto-prompt, which would hang a child process', () => {
    const built = buildSsmCommand(config(), { host: 'db', port: 1433 }, 1)
    expect(built.env.AWS_PAGER).toBe('')
    expect(built.env.AWS_CLI_AUTO_PROMPT).toBe('off')
  })

  it('trims surrounding whitespace from user input', () => {
    const built = buildSsmCommand(
      config({ credentialSource: 'cli', instanceId: '  i-0123456789abcdef0  ', profile: ' prod ' }),
      { host: '  db.internal  ', port: 1433 },
      1
    )
    expect(built.args[3]).toBe('i-0123456789abcdef0')
    expect(built.args[built.args.indexOf('--profile') + 1]).toBe('prod')
    expect(JSON.parse(built.args[built.args.indexOf('--parameters') + 1]).host).toEqual([
      'db.internal'
    ])
  })

  it('passes the parameters as one JSON argv element, so no shell quoting is needed', () => {
    const built = buildSsmCommand(
      config(),
      { host: "weird host & name;rm -rf /", port: 1433 },
      1
    )
    const raw = built.args[built.args.indexOf('--parameters') + 1]
    expect(JSON.parse(raw).host).toEqual(["weird host & name;rm -rf /"])
  })

  it('rejects a missing or malformed instance id', () => {
    expect(() => buildSsmCommand(config({ instanceId: '' }), { host: 'db', port: 1433 }, 1)).toThrow(
      /instance ID is required/
    )
    expect(() =>
      buildSsmCommand(config({ instanceId: 'not-an-instance' }), { host: 'db', port: 1433 }, 1)
    ).toThrow(/does not look like an instance ID/)
  })

  it('accepts hybrid-activation managed instance ids', () => {
    expect(() =>
      buildSsmCommand(config({ instanceId: 'mi-0123456789abcdef0' }), { host: 'db', port: 1433 }, 1)
    ).not.toThrow()
  })

  it('requires a database host in remote-host mode', () => {
    expect(() => buildSsmCommand(config(), { host: '', port: 1433 }, 1)).toThrow(
      /database host is required/
    )
    // …but not when forwarding to the instance itself.
    expect(() =>
      buildSsmCommand(config({ mode: 'instance' }), { host: '', port: 1433 }, 1)
    ).not.toThrow()
  })
})

describe('classifySsmFailure', () => {
  const cases: [string, RegExp][] = [
    ['SessionManagerPlugin is not found', /Session Manager plugin is not installed/],
    ['spawn aws ENOENT', /AWS CLI was not found/],
    ['An error occurred (TargetNotConnected) when calling', /not connected to Systems Manager/],
    ['An error occurred (AccessDeniedException)', /Access denied by IAM/],
    ['The security token included in the request is expired', /credentials have expired/],
    ['Unable to locate credentials', /No AWS credentials were found/],
    ['The config profile (nope) could not be found', /profile does not exist/],
    ['bind: address already in use', /local port is already in use/],
    ['Could not connect to the endpoint URL', /reach the AWS Systems Manager endpoint/],
    ['An error occurred (InvalidInstanceId)', /does not recognise that instance ID/]
  ]

  it.each(cases)('turns %j into actionable advice', (output, expected) => {
    expect(classifySsmFailure(output, 254)).toMatch(expected)
  })

  it('recognises every wording the CLI uses for credentials that ran out', () => {
    for (const output of [
      'The security token included in the request is expired',
      'ExpiredToken: The provided token has expired',
      'Error loading SSO Token: sso session associated',
      'The SSO session associated with this profile has expired'
    ]) {
      expect(isExpiredCredentialsFailure(output)).toBe(true)
    }
    expect(isExpiredCredentialsFailure('An error occurred (AccessDeniedException)')).toBe(false)
    expect(isExpiredCredentialsFailure('bind: address already in use')).toBe(false)
  })

  it('mentions SSO when the session has expired', () => {
    expect(classifySsmFailure('Error loading SSO Token: sso session associated', 253)).toMatch(
      /aws sso login/
    )
  })

  it('falls back to the tail of the output', () => {
    expect(classifySsmFailure('something unexpected happened', 1)).toContain(
      'something unexpected happened'
    )
  })

  it('still says something useful when the CLI printed nothing', () => {
    expect(classifySsmFailure('   ', 1)).toMatch(/exited with code 1/)
  })

  it('passes on the destination advice when the far end was unreachable', () => {
    const output = 'Unable to dial connection to port 1433: connect: connection refused'
    expect(classifySsmFailure(output, 255, 'Check the security group.')).toBe(
      'Check the security group.'
    )
    // …and still says something without it.
    expect(classifySsmFailure(output, 255)).toMatch(/could not be reached at the far end/)
  })
})

describe('destination diagnosis', () => {
  const target = { host: 'db.internal', port: 1433 }

  it('names the remote host when the bastion is only relaying', () => {
    const advice = describeSsmDestination(config({ mode: 'remote-host' }), target)
    expect(advice).toContain('db.internal:1433')
    expect(advice).toMatch(/security group/)
  })

  it('calls out a loopback Server, which names the bastion once relayed', () => {
    for (const host of ['localhost', '127.0.0.1', 'LOCALHOST.', '::1']) {
      const advice = describeSsmDestination(config({ mode: 'remote-host' }), { host, port: 1433 })
      expect(advice).toMatch(/resolved from i-0123456789abcdef0/)
      expect(advice).toMatch(/dialled port 1433 on the bastion itself/)
      // The security-group advice would be a wild goose chase here.
      expect(advice).not.toMatch(/security group/)
    }
  })

  it('leaves a real address to the ordinary advice', () => {
    const advice = describeSsmDestination(config({ mode: 'remote-host' }), {
      host: 'landfdb.abc123.eu-west-1.rds.amazonaws.com',
      port: 1433
    })
    expect(advice).toMatch(/security group/)
    expect(advice).not.toMatch(/resolved from/)
  })

  it('points at the "Forward to" setting when forwarding to the instance itself', () => {
    const advice = describeSsmDestination(config({ mode: 'instance' }), target)
    expect(advice).toContain('i-0123456789abcdef0')
    expect(advice).toMatch(/nothing is listening on port 1433/)
    // The likeliest fix: the database is not on the bastion at all.
    expect(advice).toMatch(/Forward to/)
    expect(advice).toMatch(/remote host/)
  })

  it('only fires on the phrases the plugin and agent actually use', () => {
    expect(
      classifySsmRuntimeFailure(
        '\nConnection to destination port failed, check SSM Agent logs.\n',
        'advice'
      )
    ).toBe('advice')
    expect(
      classifySsmRuntimeFailure('Unable to dial connection to server: dial tcp', 'advice')
    ).toBe('advice')
    expect(classifySsmRuntimeFailure('Waiting for connections...', 'advice')).toBeNull()
  })
})

describe('SsmTunnel against a stand-in CLI', () => {
  let upstream: net.Server
  let upstreamPort: number
  let argsFile: string
  const tunnels: SsmTunnel[] = []

  /** A trivial echo server standing in for SQL Server behind the bastion. */
  beforeEach(async () => {
    argsFile = join(tmpdir(), `fake-aws-args-${Date.now()}-${Math.random()}.json`)
    upstream = net.createServer((socket) => socket.pipe(socket))
    upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => {
        const address = upstream.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
  })

  afterEach(async () => {
    await Promise.all(tunnels.map((tunnel) => tunnel.close()))
    tunnels.length = 0
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    rmSync(argsFile, { force: true })
  })

  function makeTunnel(overrides: Partial<SsmConfig> = {}, scenario = 'ok'): SsmTunnel {
    process.env.FAKE_AWS_SCENARIO = scenario
    process.env.FAKE_AWS_UPSTREAM_PORT = String(upstreamPort)
    process.env.FAKE_AWS_ARGS_FILE = argsFile
    const tunnel = new SsmTunnel(
      config({ awsCliPath: process.execPath, startTimeoutMs: 15000, ...overrides }),
      { host: 'db.internal', port: 1433 },
      undefined,
      // The stand-in is a Node script, so the script path leads the arguments.
      ((command: string, args: string[], options: object) => {
        const { spawn } = require('node:child_process')
        return spawn(command, [FAKE_CLI, ...args], options)
      }) as never
    )
    tunnels.push(tunnel)
    return tunnel
  }

  it('opens a local port and carries traffic to the upstream', async () => {
    const tunnel = makeTunnel()
    const handle = await tunnel.open()

    expect(handle.localHost).toBe('127.0.0.1')
    expect(handle.localPort).toBeGreaterThan(0)

    // Round-trip a payload to prove the forward is real, not just a bound port.
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: handle.localPort }, () => {
        socket.write('SELECT 1')
      })
      socket.on('data', (data) => {
        resolve(data.toString())
        socket.end()
      })
      socket.on('error', reject)
    })
    expect(echoed).toBe('SELECT 1')
  })

  it('invokes the CLI with the arguments we expect', async () => {
    const tunnel = makeTunnel({ credentialSource: 'cli', profile: 'prod', region: 'eu-west-2' })
    const handle = await tunnel.open()

    const recorded = JSON.parse(readFileSync(argsFile, 'utf8'))
    expect(recorded.args).toContain('start-session')
    expect(recorded.args).toContain(SSM_DOCUMENT_REMOTE_HOST)
    expect(recorded.args).toContain('prod')
    expect(recorded.args).toContain('eu-west-2')
    expect(recorded.env.AWS_PAGER).toBe('')

    const parameters = JSON.parse(recorded.args[recorded.args.indexOf('--parameters') + 1])
    expect(parameters.localPortNumber[0]).toBe(String(handle.localPort))
    expect(parameters.host).toEqual(['db.internal'])
  })

  it('allocates a free ephemeral port when none is configured', async () => {
    const a = await makeTunnel().open()
    const b = await makeTunnel().open()
    expect(a.localPort).not.toBe(b.localPort)
  })

  it('honours a fixed local port', async () => {
    const port = await findFreePort()
    const handle = await makeTunnel({ localPort: port }).open()
    expect(handle.localPort).toBe(port)
  })

  it('releases the port when closed', async () => {
    const tunnel = makeTunnel()
    const handle = await tunnel.open()
    await tunnel.close()

    const stillOpen = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: handle.localPort })
      socket.setTimeout(1500)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })
    expect(stillOpen).toBe(false)
  })

  it('is safe to close twice', async () => {
    const tunnel = makeTunnel()
    await tunnel.open()
    await tunnel.close()
    await expect(tunnel.close()).resolves.toBeUndefined()
  })

  it.each([
    ['plugin-missing', /Session Manager plugin is not installed/],
    ['target-not-connected', /not connected to Systems Manager/],
    ['access-denied', /Access denied by IAM/],
    ['expired', /credentials have expired/],
    ['no-credentials', /No AWS credentials were found/],
    ['bad-profile', /profile does not exist/],
    ['port-in-use', /local port is already in use/]
  ])('reports the %s failure in plain language', async (scenario, expected) => {
    const tunnel = makeTunnel({}, scenario)
    await expect(tunnel.open()).rejects.toThrow(expected)
  })

  it('tags an expiry so the UI can offer a paste box', async () => {
    const tunnel = makeTunnel({}, 'expired')
    await expect(tunnel.open()).rejects.toMatchObject({
      name: 'SsmTunnelError',
      code: SSM_CREDENTIALS_EXPIRED
    })
  })

  it('leaves other failures untagged', async () => {
    const tunnel = makeTunnel({}, 'access-denied')
    const error = await tunnel.open().catch((caught: unknown) => caught as SsmTunnelError)
    expect(error).toBeInstanceOf(SsmTunnelError)
    expect((error as SsmTunnelError).code).toBeUndefined()
  })

  it('keeps the raw CLI output for the details pane', async () => {
    const tunnel = makeTunnel({}, 'target-not-connected')
    await expect(tunnel.open()).rejects.toMatchObject({
      name: 'SsmTunnelError',
      detail: expect.stringContaining('TargetNotConnected')
    })
  })

  it('fails fast when the CLI dies rather than waiting out the timeout', async () => {
    const tunnel = makeTunnel({ startTimeoutMs: 20000 }, 'expired')
    const started = Date.now()
    await expect(tunnel.open()).rejects.toThrow(SsmTunnelError)
    // The process exits immediately; we must not sit on the full timeout.
    expect(Date.now() - started).toBeLessThan(8000)
  })

  it('passes injected credentials to the CLI, overriding the inherited env', async () => {
    process.env.FAKE_AWS_SCENARIO = 'ok'
    process.env.FAKE_AWS_UPSTREAM_PORT = String(upstreamPort)
    process.env.FAKE_AWS_ARGS_FILE = argsFile
    process.env.FAKE_AWS_ECHO_ENV = 'AWS_ACCESS_KEY_ID,AWS_SESSION_TOKEN,AWS_PROFILE'
    process.env.AWS_PROFILE = 'stale-profile-from-the-shell'

    const tunnel = new SsmTunnel(
      config({ awsCliPath: process.execPath, credentialSource: 'pasted' }),
      { host: 'db.internal', port: 1433 },
      { AWS_ACCESS_KEY_ID: 'ASIATEST', AWS_SESSION_TOKEN: 'token-123', AWS_PROFILE: '' },
      ((command: string, args: string[], options: object) => {
        const { spawn } = require('node:child_process')
        return spawn(command, [FAKE_CLI, ...args], options)
      }) as never
    )
    tunnels.push(tunnel)
    await tunnel.open()

    const recorded = JSON.parse(readFileSync(argsFile, 'utf8'))
    expect(recorded.env.AWS_ACCESS_KEY_ID).toBe('ASIATEST')
    expect(recorded.env.AWS_SESSION_TOKEN).toBe('token-123')
    // The pasted block must win over a profile left over in the environment.
    expect(recorded.env.AWS_PROFILE).toBe('')

    delete process.env.AWS_PROFILE
    delete process.env.FAKE_AWS_ECHO_ENV
  })

  it('times out when the session never opens the port', async () => {
    const tunnel = makeTunnel({ startTimeoutMs: 1500 }, 'hang')
    await expect(tunnel.open()).rejects.toThrow(/Timed out waiting for the local port/)
  })

  /**
   * Session Manager binds the local port before anything is dialled at the far
   * end, so a destination that is not listening looks like a healthy session
   * until traffic flows — and then the driver only sees "socket hang up".
   */
  describe('a destination the session cannot reach', () => {
    /** Connects, waits for the far end to drop us, and reports nothing useful. */
    async function connectAndLoseIt(port: number): Promise<void> {
      await new Promise<void>((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port })
        socket.once('close', () => resolve())
        socket.once('error', () => resolve())
        socket.setTimeout(3000, () => {
          socket.destroy()
          resolve()
        })
      })
    }

    it('reports what the session said, while the session is still running', async () => {
      const tunnel = makeTunnel({ mode: 'instance' }, 'destination-refused')
      const handle = await tunnel.open()

      // The tunnel opened cleanly: the failure only shows on the first byte.
      expect(tunnel.lastForwardError).toBeNull()
      await connectAndLoseIt(handle.localPort)

      const error = await tunnel.waitForForwardError(3000)
      expect(error?.message).toMatch(/nothing is listening on port 1433/)
      expect(error?.message).toMatch(/Forward to/)
    })

    it('names the remote host instead when the bastion is relaying', async () => {
      const tunnel = makeTunnel({ mode: 'remote-host' }, 'destination-refused')
      const handle = await tunnel.open()
      await connectAndLoseIt(handle.localPort)

      const error = await tunnel.waitForForwardError(3000)
      expect(error?.message).toContain('db.internal:1433')
    })

    it('waits out the race when the session dies just after the socket does', async () => {
      const tunnel = makeTunnel({ mode: 'remote-host' }, 'dies-on-connect')
      const handle = await tunnel.open()
      await connectAndLoseIt(handle.localPort)

      // Reading it straight away is exactly the race the grace period covers.
      const error = await tunnel.waitForForwardError(3000)
      expect(error?.message).toContain('db.internal:1433')
    })

    it('stays quiet on a healthy session', async () => {
      const tunnel = makeTunnel()
      const handle = await tunnel.open()

      // A round trip that works, closed from this end: nothing to report.
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: handle.localPort }, () =>
          socket.write('SELECT 1')
        )
        socket.on('data', () => socket.end())
        socket.on('close', () => resolve())
        socket.on('error', reject)
      })
      expect(await tunnel.waitForForwardError(300)).toBeNull()
    })
  })

  it('takes the plugin at its word rather than spending a connection to probe', async () => {
    // AWS-StartPortForwardingSession carries one client at a time, so a probe
    // that connects and hangs up can cost the connection that follows.
    const tunnel = makeTunnel({ mode: 'instance' }, 'count-connections')
    const handle = await tunnel.open()

    const connections = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: handle.localPort })
      socket.on('data', (data) => {
        resolve(data.toString())
        socket.end()
      })
      socket.on('error', reject)
    })
    expect(connections).toBe('connection 1')
  })
})
