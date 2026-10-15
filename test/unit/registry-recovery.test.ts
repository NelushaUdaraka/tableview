/**
 * What happens to a connection that drops while nobody is looking.
 *
 * The client notices — a heartbeat that fails, or a query that comes back with
 * a dead socket — and says so. The registry's job is to turn that into a status
 * for the window that owns the connection, and to stop listening to a client it
 * has closed: a stale client reporting into a live slot would tell a window its
 * connection had dropped when it had merely been replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientStateEvent, ClientStateListener } from '../../src/main/db/types'
import {
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  type ConnectionConfig,
  type ConnectionStatus
} from '../../src/shared/types'

/** Every fake client built during a test, newest last. */
const built: FakeClient[] = []

class FakeClient {
  listener: ClientStateListener | null = null
  connected = false
  readonly tunnelPort = 14330
  readonly info = {
    productVersion: '16.0.1000',
    edition: 'Developer Edition',
    productLevel: 'RTM',
    machineName: 'test',
    currentDatabase: 'sales',
    login: 'sa',
    currentUser: 'dbo',
    versionString: 'Microsoft SQL Server 2022'
  }

  constructor(public readonly currentConfig: ConnectionConfig) {
    built.push(this)
  }

  get isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<FakeClient['info']> {
    this.connected = true
    return this.info
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  onStateChange(listener: ClientStateListener | null): void {
    this.listener = listener
  }

  /** Stands in for the heartbeat or a failed query reporting a drop. */
  report(event: ClientStateEvent): void {
    this.listener?.(event)
  }
}

vi.mock('../../src/main/db/sqlserver/client', () => ({
  SqlServerClient: FakeClient,
  serializeError: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error)
  })
}))

const { ConnectionRegistry } = await import('../../src/main/db/registry')

function config(): ConnectionConfig {
  return {
    id: 'c1',
    name: 'Test',
    engine: 'sqlserver',
    host: '127.0.0.1',
    port: 1433,
    authType: 'sql',
    username: 'sa',
    savePassword: false,
    options: { ...DEFAULT_SQLSERVER_OPTIONS },
    ssh: { ...DEFAULT_SSH_CONFIG },
    ssm: { ...DEFAULT_SSM_CONFIG },
    createdAt: '',
    updatedAt: ''
  }
}

async function openOne(): Promise<{
  registry: InstanceType<typeof ConnectionRegistry>
  client: FakeClient
  seen: { scope: string; status: ConnectionStatus }[]
}> {
  const registry = new ConnectionRegistry()
  const seen: { scope: string; status: ConnectionStatus }[] = []
  registry.onStatusChange((scope, status) => seen.push({ scope, status }))
  await registry.open('win1', config())
  return { registry, client: built[built.length - 1], seen }
}

beforeEach(() => {
  built.length = 0
})

describe('a connection that drops on its own', () => {
  it('reaches the window that owns it as a reconnection, with the reason', async () => {
    const { client, seen } = await openOne()
    client.connected = false
    client.report({ state: 'reconnecting', error: new Error('socket hang up') })

    expect(seen).toHaveLength(1)
    expect(seen[0].scope).toBe('win1')
    expect(seen[0].status).toEqual({
      connectionId: 'c1',
      state: 'connecting',
      error: { message: 'socket hang up' }
    })
  })

  it('reads as connecting rather than gone while it is being reopened', async () => {
    const { registry, client } = await openOne()
    client.connected = false
    client.report({ state: 'reconnecting', error: new Error('socket hang up') })

    expect(registry.status('win1', 'c1').state).toBe('connecting')
  })

  it('reports the server again once it is back', async () => {
    const { registry, client, seen } = await openOne()
    client.connected = false
    client.report({ state: 'reconnecting', error: new Error('socket hang up') })
    client.connected = true
    client.report({ state: 'connected' })

    expect(seen[1].status).toMatchObject({
      connectionId: 'c1',
      state: 'connected',
      currentDatabase: 'sales',
      tunnelPort: 14330
    })
    expect(registry.status('win1', 'c1').state).toBe('connected')
  })

  it('gives up as disconnected, carrying the last failure', async () => {
    const { registry, client, seen } = await openOne()
    client.connected = false
    client.report({ state: 'disconnected', error: new Error('credentials expired') })

    expect(seen[0].status).toEqual({
      connectionId: 'c1',
      state: 'disconnected',
      error: { message: 'credentials expired' }
    })
    expect(registry.status('win1', 'c1').state).toBe('disconnected')
  })

  it('stops listening to a client it has closed', async () => {
    const { registry, client, seen } = await openOne()
    await registry.close('win1', 'c1')

    client.report({ state: 'reconnecting', error: new Error('too late') })
    expect(seen).toHaveLength(0)
    expect(client.listener).toBeNull()
  })

  it('ignores a replaced client still reporting into the slot', async () => {
    const { registry, client: first, seen } = await openOne()
    // Reopening the same connection builds a second client for the same slot.
    await registry.open('win1', config())
    const second = built[built.length - 1]
    expect(second).not.toBe(first)

    first.report({ state: 'reconnecting', error: new Error('stale') })
    expect(seen).toHaveLength(0)

    second.report({ state: 'reconnecting', error: new Error('live') })
    expect(seen).toHaveLength(1)
    expect(seen[0].status.error).toEqual({ message: 'live' })
  })

  it('names the window whose connection went, not the other one holding the same id', async () => {
    const registry = new ConnectionRegistry()
    const seen: { scope: string; status: ConnectionStatus }[] = []
    registry.onStatusChange((scope, status) => seen.push({ scope, status }))
    await registry.open('win1', config())
    const first = built[built.length - 1]
    await registry.open('win2', config())

    first.connected = false
    first.report({ state: 'reconnecting', error: new Error('socket hang up') })

    expect(seen.map((entry) => entry.scope)).toEqual(['win1'])
    expect(registry.status('win2', 'c1').state).toBe('connected')
  })

  it('forgets a recovering connection when its window closes', async () => {
    const { registry, client } = await openOne()
    client.connected = false
    client.report({ state: 'reconnecting', error: new Error('socket hang up') })

    await registry.closeScope('win1')
    expect(registry.status('win1', 'c1').state).toBe('disconnected')
  })
})

/**
 * Whether the open connection refuses writes.
 *
 * Said by the registry, from the settings the connection was opened with,
 * because those are the settings the client enforces: a window that read it
 * from the saved list instead could show a lock that the open connection is
 * not keeping, once the list was edited from another window.
 */
describe('a read-only connection', () => {
  it('says it is read-only when it opens, and while it stays open', async () => {
    const registry = new ConnectionRegistry()
    const opened = await registry.open('win1', { ...config(), readOnly: true })

    expect(opened.readOnly).toBe(true)
    expect(registry.status('win1', 'c1').readOnly).toBe(true)
  })

  it('says so again when it comes back after a drop', async () => {
    const registry = new ConnectionRegistry()
    const seen: ConnectionStatus[] = []
    registry.onStatusChange((_scope, status) => seen.push(status))
    await registry.open('win1', { ...config(), readOnly: true })
    const client = built[built.length - 1]

    client.connected = false
    client.report({ state: 'reconnecting', error: new Error('socket hang up') })
    client.connected = true
    client.report({ state: 'connected' })

    expect(seen.at(-1)).toMatchObject({ state: 'connected', readOnly: true })
  })

  it('says a writable connection is not read-only', async () => {
    const { registry } = await openOne()
    expect(registry.status('win1', 'c1').readOnly).toBe(false)
  })
})
