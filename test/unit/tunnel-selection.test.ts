import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'
import {
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  type ConnectionConfig
} from '../../src/shared/types'

const FAKE_CLI = join(__dirname, '../fixtures/fake-aws.mjs')

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'c1',
    name: 'Test',
    engine: 'sqlserver',
    host: 'db.internal',
    port: 1433,
    authType: 'sql',
    username: 'sa',
    password: 'x',
    savePassword: false,
    options: { ...DEFAULT_SQLSERVER_OPTIONS, connectTimeoutMs: 1500 },
    ssh: { ...DEFAULT_SSH_CONFIG },
    ssm: { ...DEFAULT_SSM_CONFIG },
    createdAt: '',
    updatedAt: '',
    ...overrides
  }
}

describe('transport selection', () => {
  it('refuses to enable both transports, which would each claim a local port', async () => {
    const client = new SqlServerClient(
      config({
        ssh: { ...DEFAULT_SSH_CONFIG, enabled: true, host: 'bastion', username: 'u' },
        ssm: { ...DEFAULT_SSM_CONFIG, enabled: true, instanceId: 'i-0123456789abcdef0' }
      })
    )
    await expect(client.connect()).rejects.toThrow(/either the SSH tunnel or the AWS SSM session/i)
    await client.disconnect()
  })

  it('surfaces an invalid instance id before trying to reach AWS', async () => {
    const client = new SqlServerClient(
      config({
        ssm: {
          ...DEFAULT_SSM_CONFIG,
          enabled: true,
          credentialSource: 'cli',
          instanceId: 'nonsense'
        }
      })
    )
    await expect(client.connect()).rejects.toThrow(/does not look like an instance ID/)
    await client.disconnect()
  })

  it('says so when a connection wants pasted credentials but none are set', async () => {
    const client = new SqlServerClient(
      config({
        ssm: {
          ...DEFAULT_SSM_CONFIG,
          enabled: true,
          credentialSource: 'pasted',
          instanceId: 'i-0123456789abcdef0'
        }
      })
    )
    await expect(client.connect()).rejects.toThrow(/pasted AWS credentials, but none are saved against it/)
    await client.disconnect()
  })

  it('reports no tunnel port when connecting directly', () => {
    const client = new SqlServerClient(config())
    expect(client.tunnelPort).toBeUndefined()
  })
})

/**
 * The failure the driver cannot describe: Session Manager binds the local port
 * before anything is dialled at the far end, so a destination that is not
 * listening only shows up as the driver's socket closing. Unhandled, the user
 * is told "socket hang up" about a session that started perfectly well.
 */
describe.skipIf(process.platform === 'win32')('a forward that drops the connection', () => {
  const shims: string[] = []

  afterEach(() => {
    for (const shim of shims.splice(0)) rmSync(shim, { force: true })
    delete process.env.FAKE_AWS_SCENARIO
  })

  /** The stand-in CLI is a Node script; the config only takes a command. */
  function fakeAwsCli(scenario: string): string {
    process.env.FAKE_AWS_SCENARIO = scenario
    const shim = join(tmpdir(), `fake-aws-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`)
    chmodSync(shim, 0o755)
    shims.push(shim)
    return shim
  }

  function ssmConfig(
    scenario: string,
    mode: 'instance' | 'remote-host',
    startTimeoutMs = 10000
  ): ConnectionConfig {
    return config({
      ssm: {
        ...DEFAULT_SSM_CONFIG,
        enabled: true,
        credentialSource: 'cli',
        instanceId: 'i-0123456789abcdef0',
        mode,
        startTimeoutMs,
        awsCliPath: fakeAwsCli(scenario)
      }
    })
  }

  it('explains it instead of passing on the driver\'s "socket hang up"', async () => {
    const client = new SqlServerClient(ssmConfig('destination-refused', 'instance'))
    try {
      await expect(client.connect()).rejects.toThrow(
        /through the SSM session — .*nothing is listening on port 1433/
      )
    } finally {
      await client.disconnect()
    }
  })

  it('names the remote host when the bastion is only relaying', async () => {
    const client = new SqlServerClient(ssmConfig('destination-refused', 'remote-host'))
    try {
      await expect(client.connect()).rejects.toThrow(/could not reach db.internal:1433 from there/)
    } finally {
      await client.disconnect()
    }
  })

  it('still explains a drop the session itself never described', async () => {
    // No diagnosis on the pipe at all: the drop is all there is to go on.
    const client = new SqlServerClient(ssmConfig('silent-drop', 'instance'))
    try {
      const error = await client
        .connect()
        .then(() => null)
        .catch((caught: unknown) => caught as Error)
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toMatch(/accepted the connection and it was dropped immediately/)
      // The driver's own wording is kept, but no longer stands alone.
      expect(error!.message).toMatch(/socket hang up|ECONNRESET/i)
      expect(error!.message).toMatch(/"Forward to" is set to the instance/)
    } finally {
      await client.disconnect()
    }
  })

  it('still reports a session that never opened the port at all', async () => {
    // The drop handling must not swallow the failures that come first.
    const client = new SqlServerClient(ssmConfig('hang', 'instance', 1200))
    try {
      await expect(client.connect()).rejects.toThrow(/Timed out waiting for the local port/)
    } finally {
      await client.disconnect()
    }
  })
})
