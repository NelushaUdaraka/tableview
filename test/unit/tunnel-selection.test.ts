import { describe, expect, it } from 'vitest'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'
import {
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  type ConnectionConfig
} from '../../src/shared/types'

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
