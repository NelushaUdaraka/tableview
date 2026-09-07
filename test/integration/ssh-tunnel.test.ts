/**
 * Exercises the SSH tunnel against a real sshd, forwarding to a SQL Server
 * that is only reachable on the container network — so a passing test proves
 * traffic genuinely traversed the tunnel.
 *
 *   ./scratchpad/start-ssh.sh   (see helpers.ts for the SQL Server container)
 */
import net from 'node:net'
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'
import { SshTunnel } from '../../src/main/tunnel/ssh'
import type { SshConfig } from '../../src/shared/types'
import { createTestDatabase, makeConfig, seedTestDatabase, connectedClient } from './helpers'

const KEY_DIR =
  process.env.SSH_TEST_KEY_DIR ??
  '/tmp/claude-0/-root-projects-beekeeper-clone/7db9f9f0-6dbf-44c1-8fc6-2f144b6792d3/scratchpad/sshkeys'

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
    const tunnel = new SshTunnel(sshConfig(), { host: REMOTE_DB_HOST, port: REMOTE_DB_PORT })
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
    const tunnel = new SshTunnel(sshConfig(), { host: REMOTE_DB_HOST, port: REMOTE_DB_PORT })
    const handle = await tunnel.open()
    await tunnel.close()
    await expect(portIsClosed(handle.localPort)).resolves.toBe(true)
  })

  it('picks a different ephemeral port for each tunnel', async () => {
    const a = new SshTunnel(sshConfig(), { host: REMOTE_DB_HOST, port: REMOTE_DB_PORT })
    const b = new SshTunnel(sshConfig(), { host: REMOTE_DB_HOST, port: REMOTE_DB_PORT })
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
    const tunnel = new SshTunnel(sshConfig({ password: 'wrong-password' }), {
      host: REMOTE_DB_HOST,
      port: REMOTE_DB_PORT
    })
    await expect(tunnel.open()).rejects.toThrow(/SSH connection failed/i)
    await tunnel.close()
  })

  it('reports an unreachable SSH host clearly', async () => {
    const tunnel = new SshTunnel(sshConfig({ port: 1 }), {
      host: REMOTE_DB_HOST,
      port: REMOTE_DB_PORT
    })
    await expect(tunnel.open()).rejects.toThrow(/SSH connection failed/i)
    await tunnel.close()
  })
})

describe('SQL Server over an SSH tunnel', () => {
  it('connects and queries with password authentication', async () => {
    const client = new SqlServerClient(tunnelledConfig(sshConfig()))
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
      tunnelledConfig(sshConfig({ authMode: 'privateKey', privateKeyPath: keyPath, password: undefined }))
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
      )
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
      )
    )
    await expect(client.connect()).rejects.toThrow()
    await client.disconnect()
  })

  it('tears the tunnel down when the connection closes', async () => {
    const client = new SqlServerClient(tunnelledConfig(sshConfig()))
    await client.connect()
    const port = client.tunnelPort!
    await client.disconnect()
    await expect(portIsClosed(port)).resolves.toBe(true)
  })

  it('closes the tunnel when the database rejects the login', async () => {
    const config = tunnelledConfig(sshConfig())
    const client = new SqlServerClient({ ...config, password: 'wrong-sql-password' })
    await expect(client.connect()).rejects.toThrow(/login failed/i)
    // A failed database login must not strand the forwarder.
    expect(client.tunnelPort).toBeUndefined()
  })

  it('browses table data through the tunnel', async () => {
    const client = new SqlServerClient(tunnelledConfig(sshConfig()))
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
