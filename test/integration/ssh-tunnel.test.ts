/**
 * Exercises the SSH tunnel against a real sshd, forwarding to a SQL Server
 * that is only reachable on the container network — so a passing test proves
 * traffic genuinely traversed the tunnel.
 *
 *   ./scratchpad/start-ssh.sh   (see helpers.ts for the SQL Server container)
 */
import net from 'node:net'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'
import { SshTunnel } from '../../src/main/tunnel/ssh'
import {
  hostKeyPolicy,
  type HostKey,
  type HostKeyQuestion,
  type HostKeyStore
} from '../../src/main/tunnel/hostKeys'
import type { SshConfig } from '../../src/shared/types'
import { createTestDatabase, makeConfig, seedTestDatabase, connectedClient } from './helpers'

/** Where `scripts/test-env.sh up` generates the keys the sshd accepts. */
const KEY_DIR =
  process.env.SSH_TEST_KEY_DIR ?? path.resolve(__dirname, '../../.tmp/sshkeys')

const SSH_HOST = process.env.SSH_TEST_HOST ?? '127.0.0.1'
const SSH_PORT = Number(process.env.SSH_TEST_PORT ?? 2222)
const SSH_USER = process.env.SSH_TEST_USER ?? 'tunneluser'
const SSH_PASSWORD = process.env.SSH_TEST_PASSWORD ?? 'tunnelpass'

/** The database host as seen from inside the SSH container. */
const REMOTE_DB_HOST = process.env.SSH_TEST_DB_HOST ?? 'beekeeper-mssql'
const REMOTE_DB_PORT = Number(process.env.SSH_TEST_DB_PORT ?? 1433)

function sshConfig(overrides: Partial<SshConfig> = {}): SshConfig {
  return {
    enabled: true,
    host: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    authMode: 'password',
    password: SSH_PASSWORD,
    keepaliveIntervalMs: 10000,
    ...overrides
  }
}

/** Trusted keys kept in memory, so each test starts knowing no server. */
function memoryStore(seed: Record<string, HostKey> = {}): HostKeyStore {
  const keys = new Map(Object.entries(seed))
  return {
    check(host, port, key) {
      const stored = keys.get(`${host}:${port}`)
      if (!stored) return { status: 'new' }
      return stored.fingerprint === key.fingerprint ? { status: 'known' } : { status: 'changed', previous: stored }
    },
    trust(host, port, key) {
      keys.set(`${host}:${port}`, key)
    }
  }
}

/** A user who says yes to whatever key the test server shows. */
const trusting = () => hostKeyPolicy(memoryStore(), async () => true)

function tunnelledConfig(ssh: SshConfig) {
  return makeConfig({
    host: REMOTE_DB_HOST,
    port: REMOTE_DB_PORT,
    ssh
  })
}

/** True when nothing is listening on the port any more. */
async function portIsClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(2000)
    socket.on('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(true))
    socket.on('timeout', () => {
      socket.destroy()
      resolve(true)
    })
  })
}

beforeAll(async () => {
  await createTestDatabase()
  const client = await connectedClient()
  await seedTestDatabase(client)
  await client.disconnect()
}, 180000)

describe('SshTunnel', () => {
  it('forwards a local port to the remote database', async () => {
    const tunnel = new SshTunnel(sshConfig(), { host: REMOTE_DB_HOST, port: REMOTE_DB_PORT }, trusting())
    const handle = await tunnel.open()
    try {
      expect(handle.localHost).toBe('127.0.0.1')
      expect(handle.localPort).toBeGreaterThan(0)
      // The forwarded port must accept a TCP connection.
      await expect(portIsClosed(handle.localPort)).resolves.toBe(false)
    } finally {
      await tunnel.close()
    }
  })

  it('releases the local port on close', async () => {
    const tunnel = new SshTunnel(sshConfig(), { host: REMOTE_DB_HOST, port: REMOTE_DB_PORT }, trusting())
    const handle = await tunnel.open()
    await tunnel.close()
    await expect(portIsClosed(handle.localPort)).resolves.toBe(true)
  })

  it('picks a different ephemeral port for each tunnel', async () => {
    const a = new SshTunnel(sshConfig(), { host: REMOTE_DB_HOST, port: REMOTE_DB_PORT }, trusting())
    const b = new SshTunnel(sshConfig(), { host: REMOTE_DB_HOST, port: REMOTE_DB_PORT }, trusting())
    const handleA = await a.open()
    const handleB = await b.open()
    try {
      expect(handleA.localPort).not.toBe(handleB.localPort)
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('reports a bad password clearly', async () => {
    const tunnel = new SshTunnel(
      sshConfig({ password: 'wrong-password' }),
      { host: REMOTE_DB_HOST, port: REMOTE_DB_PORT },
      trusting()
    )
    await expect(tunnel.open()).rejects.toThrow(/SSH connection failed/i)
    await tunnel.close()
  })

  it('reports an unreachable SSH host clearly', async () => {
    const tunnel = new SshTunnel(
      sshConfig({ port: 1 }),
      { host: REMOTE_DB_HOST, port: REMOTE_DB_PORT },
      trusting()
    )
    await expect(tunnel.open()).rejects.toThrow(/SSH connection failed/i)
    await tunnel.close()
  })
})

describe('the SSH server\'s host key', () => {
  const target = { host: REMOTE_DB_HOST, port: REMOTE_DB_PORT }

  it('asks about a server it has not seen, and asks no more once it is trusted', async () => {
    const asked: HostKeyQuestion[] = []
    const policy = hostKeyPolicy(memoryStore(), async (question) => {
      asked.push(question)
      return true
    })
    for (let i = 0; i < 2; i += 1) {
      const tunnel = new SshTunnel(sshConfig(), target, policy)
      await tunnel.open()
      await tunnel.close()
    }
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ host: SSH_HOST, port: SSH_PORT, previous: undefined })
    expect(asked[0].key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })

  it('opens nothing on a server the user does not trust', async () => {
    const tunnel = new SshTunnel(sshConfig(), target, hostKeyPolicy(memoryStore(), async () => false))
    await expect(tunnel.open()).rejects.toThrow(/SSH server.*not trusted/i)
    await tunnel.close()
  })

  it('says so when the server answers with another key than before', async () => {
    const before = { type: 'ssh-ed25519', fingerprint: 'SHA256:not-the-key-it-has-now' }
    const asked: HostKeyQuestion[] = []
    const policy = hostKeyPolicy(memoryStore({ [`${SSH_HOST}:${SSH_PORT}`]: before }), async (question) => {
      asked.push(question)
      return false
    })
    const tunnel = new SshTunnel(sshConfig(), target, policy)
    await expect(tunnel.open()).rejects.toThrow(/changed/i)
    expect(asked[0].previous).toEqual(before)
    await tunnel.close()
  })

  it('trusts no server when it has no one to ask', async () => {
    const tunnel = new SshTunnel(sshConfig(), target)
    await expect(tunnel.open()).rejects.toThrow(/not trusted/i)
    await tunnel.close()
  })
})

describe('SQL Server over an SSH tunnel', () => {
  it('connects and queries with password authentication', async () => {
    const client = new SqlServerClient(tunnelledConfig(sshConfig()), { hostKeys: trusting() })
    try {
      const info = await client.connect()
      expect(info.currentDatabase).toBe('beekeeper_test')
      expect(client.tunnelPort).toBeGreaterThan(0)

      const [result] = await client.runScript('SELECT COUNT(*) AS n FROM dbo.customers')
      expect(result.error).toBeUndefined()
      expect(result.resultSets[0].rows[0][0]).toBe(4)
    } finally {
      await client.disconnect()
    }
  })

  it('connects with private key authentication', async () => {
    const keyPath = `${KEY_DIR}/id_ed25519`
    expect(existsSync(keyPath)).toBe(true)

    const client = new SqlServerClient(
      tunnelledConfig(sshConfig({ authMode: 'privateKey', privateKeyPath: keyPath, password: undefined })),
      { hostKeys: trusting() }
    )
    try {
      await client.connect()
      const [result] = await client.runScript('SELECT 1 AS ok')
      expect(result.resultSets[0].rows[0][0]).toBe(1)
    } finally {
      await client.disconnect()
    }
  })

  it('connects with a passphrase-protected private key', async () => {
    const keyPath = `${KEY_DIR}/id_ed25519_pp`
    expect(existsSync(keyPath)).toBe(true)

    const client = new SqlServerClient(
      tunnelledConfig(
        sshConfig({
          authMode: 'privateKey',
          privateKeyPath: keyPath,
          passphrase: 'secretpass',
          password: undefined
        })
      ),
      { hostKeys: trusting() }
    )
    try {
      await client.connect()
      const [result] = await client.runScript('SELECT 1 AS ok')
      expect(result.resultSets[0].rows[0][0]).toBe(1)
    } finally {
      await client.disconnect()
    }
  })

  it('fails on a wrong passphrase', async () => {
    const client = new SqlServerClient(
      tunnelledConfig(
        sshConfig({
          authMode: 'privateKey',
          privateKeyPath: `${KEY_DIR}/id_ed25519_pp`,
          passphrase: 'not-the-passphrase',
          password: undefined
        })
      ),
      { hostKeys: trusting() }
    )
    await expect(client.connect()).rejects.toThrow()
    await client.disconnect()
  })

  it('tears the tunnel down when the connection closes', async () => {
    const client = new SqlServerClient(tunnelledConfig(sshConfig()), { hostKeys: trusting() })
    await client.connect()
    const port = client.tunnelPort!
    await client.disconnect()
    await expect(portIsClosed(port)).resolves.toBe(true)
  })

  it('closes the tunnel when the database rejects the login', async () => {
    const config = tunnelledConfig(sshConfig())
    const client = new SqlServerClient({ ...config, password: 'wrong-sql-password' }, { hostKeys: trusting() })
    await expect(client.connect()).rejects.toThrow(/login failed/i)
    // A failed database login must not strand the forwarder.
    expect(client.tunnelPort).toBeUndefined()
  })

  it('browses table data through the tunnel', async () => {
    const client = new SqlServerClient(tunnelledConfig(sshConfig()), { hostKeys: trusting() })
    try {
      await client.connect()
      const response = await client.fetchTableData({
        connectionId: 'test-connection',
        schema: 'dbo',
        table: 'customers',
        offset: 0,
        limit: 10,
        sorts: [{ column: 'customer_id', direction: 'asc' }],
        filters: [],
        filterMode: 'builder'
      })
      expect(response.rows.length).toBeGreaterThan(0)
      expect(response.totalRows).toBeGreaterThan(0)
    } finally {
      await client.disconnect()
    }
  })
})
