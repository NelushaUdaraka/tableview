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
import type {
  ClientStateEvent,
  ClientStateListener,
  SessionChange,
  SessionChangeListener
} from '../../src/main/db/types'
import {
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  type ConnectionConfig,
  type ConnectionStatus,
  type SessionState
} from '../../src/shared/types'

/** Every fake client built during a test, newest last. */
const built: FakeClient[] = []

/** While set, a fake client's connect waits on it — a tunnel still coming up. */
let connectGate: Promise<void> | null = null

/** While set, the next fake client's connect fails with it. */
let connectFailure: Error | null = null

class FakeClient {
  listener: ClientStateListener | null = null
  sessionListener: SessionChangeListener | null = null
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

  constructor(public currentConfig: ConnectionConfig) {
    built.push(this)
  }

  setReadOnly(readOnly: boolean): void {
    this.currentConfig = { ...this.currentConfig, readOnly }
  }

  get isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<FakeClient['info']> {
    if (connectGate) await connectGate
    const failure = connectFailure
    connectFailure = null
    if (failure) throw failure
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

  onSessionChange(listener: SessionChangeListener | null): void {
    this.sessionListener = listener
  }

  /** Stands in for a tab's session moving with the sidebar, or being lost. */
  reportSession(change: SessionChange): void {
    this.sessionListener?.(change)
  }

  /** What the client hands on when it is replaced; set by a test. */
  retiring = new Map<string, SessionState>()
  /** What it was handed by the client it replaced. */
  adopted: Map<string, SessionState> | null = null

  retireSessions(): Map<string, SessionState> {
    return this.retiring
  }

  adoptLostSessions(lost: Map<string, SessionState>): void {
    this.adopted = lost
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
  connectGate = null
  connectFailure = null
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

/**
 * Read-only switched while connections are open.
 *
 * It is one setting on one saved connection, so every window that has that
 * connection open switches with it, and each is told — the window that did it
 * and any other one — so no lock stays on screen that is no longer kept.
 */
describe('switching read-only on an open connection', () => {
  function listen(registry: InstanceType<typeof ConnectionRegistry>) {
    const seen: { scope: string; status: ConnectionStatus }[] = []
    registry.onStatusChange((scope, status) => seen.push({ scope, status }))
    return seen
  }

  it('switches every window that has the connection open, and tells each one', async () => {
    const registry = new ConnectionRegistry()
    const seen = listen(registry)
    await registry.open('win1', config())
    await registry.open('win2', config())
    await registry.open('win2', { ...config(), id: 'c2' })

    registry.setReadOnly('c1', true)

    expect(seen.map(({ scope, status }) => [scope, status.connectionId, status.readOnly])).toEqual([
      ['win1', 'c1', true],
      ['win2', 'c1', true]
    ])
    expect(registry.status('win1', 'c1').readOnly).toBe(true)
    expect(registry.status('win2', 'c2').readOnly).toBe(false)
  })

  it('says nothing to a window whose connection is already that way', async () => {
    const registry = new ConnectionRegistry()
    const seen = listen(registry)
    await registry.open('win1', { ...config(), readOnly: true })

    registry.setReadOnly('c1', true)
    expect(seen).toHaveLength(0)
  })

  it('keeps saying read-only while a dropped connection is put back', async () => {
    const { registry, client } = await openOne()
    client.connected = false
    client.report({ state: 'reconnecting', error: new Error('socket hang up') })

    registry.setReadOnly('c1', true)
    expect(registry.status('win1', 'c1')).toMatchObject({ state: 'connecting', readOnly: true })
  })

  it('leaves alone a connection nobody has open', () => {
    const registry = new ConnectionRegistry()
    const seen = listen(registry)
    expect(() => registry.setReadOnly('c1', true)).not.toThrow()
    expect(seen).toHaveLength(0)
  })

  it('reaches a connection still opening, which opens the way it was switched', async () => {
    const registry = new ConnectionRegistry()
    let release = (): void => undefined
    connectGate = new Promise((resolve) => (release = resolve))
    // Handed the config as it was before the switch, as a slow tunnel would be.
    const opening = registry.open('win1', config())

    registry.setReadOnly('c1', true)
    release()

    expect(await opening).toMatchObject({ state: 'connected', readOnly: true })
    expect(registry.find('win1', 'c1')?.currentConfig.readOnly).toBe(true)
  })

  it('opens the way it is told when the switch came before it started', async () => {
    const registry = new ConnectionRegistry()
    registry.setReadOnly('c1', true)

    // Read afresh for this open, so the config is the later word.
    expect(await registry.open('win1', config())).toMatchObject({ readOnly: false })
  })
})

/**
 * A tab's session can change with no call to answer: the sidebar's database
 * switch moves it, or its connection is lost. The registry passes that on to
 * the window that owns the connection, and stops listening once it has closed
 * the client — a replaced client's sessions are not this window's any more.
 */
describe('a session that changes on its own', () => {
  it('reaches the window that owns it', async () => {
    const { registry, client } = await openOne()
    const seen: [string, string, SessionChange][] = []
    registry.onSessionChange((scope, connectionId, change) => seen.push([scope, connectionId, change]))
    const change: SessionChange = {
      sessionId: 'tab-3',
      state: null,
      lost: { transactionCount: 1, transactionState: 1, database: 'sales' }
    }
    client.reportSession(change)
    expect(seen).toEqual([['win1', 'c1', change]])
  })

  it('is not heard from a client that has been closed', async () => {
    const { registry, client } = await openOne()
    const seen: unknown[] = []
    registry.onSessionChange((...args) => seen.push(args))
    await registry.close('win1', 'c1')
    client.reportSession({ sessionId: 'tab-3', state: null })
    expect(seen).toEqual([])
  })
})

/**
 * Reconnecting by hand — after the client gave up on a drop, say — replaces
 * the client. The tabs' sessions do not come back with it, and what they had
 * goes on to the new client, so a tab's next run is held to the same rule as
 * if its session had been lost on the new one.
 */
describe('reconnecting by hand', () => {
  const had: SessionState = { transactionCount: 1, transactionState: 1, database: 'sales' }

  it('hands what the replaced client lost to the client that replaces it', async () => {
    const { registry, client } = await openOne()
    client.retiring = new Map([['tab-3', had]])
    await registry.open('win1', config())
    expect(built.at(-1)!.adopted).toEqual(new Map([['tab-3', had]]))
  })

  it('keeps it through a reopen that fails, for the one after', async () => {
    const { registry, client } = await openOne()
    client.retiring = new Map([['tab-3', had]])
    connectFailure = new Error('Login failed')
    expect((await registry.open('win1', config())).state).toBe('error')
    await registry.open('win1', config())
    expect(built.at(-1)!.adopted).toEqual(new Map([['tab-3', had]]))
  })

  it('lets it go when the connection is closed on purpose', async () => {
    const { registry, client } = await openOne()
    client.retiring = new Map([['tab-3', had]])
    await registry.close('win1', 'c1')
    await registry.open('win1', config())
    expect(built.at(-1)!.adopted).toBeNull()
  })
})
