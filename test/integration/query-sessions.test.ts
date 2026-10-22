/**
 * A query tab's session, against a real SQL Server.
 *
 * Every run in a tab used to borrow whichever connection the window's pool
 * had free, so a temp table, a `USE` or an open transaction from one run was
 * at the mercy of the next — and of the table tabs and the schema tree, which
 * borrowed from the same pool. Each tab now holds a session of its own; these
 * are the behaviours that make that true.
 */
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ConnectionRegistry } from '../../src/main/db/registry'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'
import { QuerySession } from '../../src/main/db/sqlserver/session'
import type { SessionChange, SessionRun } from '../../src/main/db/types'
import { COMMIT_SQL } from '../../src/shared/sessions'
import {
  READ_ONLY_CONNECTION,
  SESSION_LOST,
  type ConnectionConfig,
  type SessionState,
  type TableDataRequest
} from '../../src/shared/types'
import {
  TEST_DATABASE,
  TEST_HOST,
  TEST_PORT,
  connectedClient,
  createTestDatabase,
  makeConfig
} from './helpers'

let admin: SqlServerClient
const clients: SqlServerClient[] = []
const sessions: QuerySession[] = []

beforeAll(async () => {
  await createTestDatabase()
  admin = await connectedClient()
  const [seeded] = await admin.runScript(`
    IF OBJECT_ID('dbo.session_items') IS NOT NULL DROP TABLE dbo.session_items;
    CREATE TABLE dbo.session_items (id int PRIMARY KEY, name nvarchar(50));
    INSERT dbo.session_items VALUES (1, N'original'), (2, N'b');`)
  expect(seeded.error).toBeUndefined()
  // Two more databases for the sidebar to switch between: an ordinary one,
  // and one whose name only works quoted.
  for (const create of [
    "IF DB_ID(N'tv_sessions_other') IS NULL CREATE DATABASE tv_sessions_other;",
    "IF DB_ID(N'tv sessions]odd') IS NULL CREATE DATABASE [tv sessions]]odd];"
  ]) {
    const [created] = await admin.runScript(create)
    expect(created.error).toBeUndefined()
  }
}, 180000)

afterAll(async () => {
  for (const session of sessions) await session.close().catch(() => undefined)
  for (const client of clients) await client.disconnect()
  await admin?.disconnect()
})

/** The first cell of the last result set, read through the shared pool. */
async function scalar(client: SqlServerClient, text: string): Promise<unknown> {
  const results = await client.runScript(text)
  const failed = results.find((result) => result.error)
  if (failed) throw new Error(failed.error!.message)
  return results.at(-1)?.resultSets.at(-1)?.rows[0]?.[0]
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`gave up waiting after ${ms}ms`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * How many sessions the server lists for an application name, once it has
 * caught up: a connection closed a moment ago can still be listed while the
 * server notices it went.
 */
async function serverSessions(program: string, expected = 0, ms = 3000): Promise<unknown> {
  const count = (): Promise<unknown> =>
    scalar(admin, `SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE program_name = '${program}'`)
  const end = Date.now() + ms
  let seen = await count()
  while (seen !== expected && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    seen = await count()
  }
  return seen
}

/** A connected client whose tabs the tests run on; disconnected after the suite. */
async function tabClient(overrides: Partial<ConnectionConfig> = {}): Promise<SqlServerClient> {
  const client = await connectedClient(overrides)
  clients.push(client)
  return client
}

/** The first cell of the last result set a tab's run produced. */
function first(run: SessionRun): unknown {
  return run.statements.at(-1)?.resultSets.at(-1)?.rows[0]?.[0]
}

const ITEMS: TableDataRequest = {
  connectionId: 'x',
  schema: 'dbo',
  table: 'session_items',
  offset: 0,
  limit: 10,
  sorts: [],
  filters: [],
  filterMode: 'builder'
}

async function openSession(
  onLost = (_: SessionState): void => undefined,
  options: Partial<ConnectionConfig['options']> = {}
): Promise<QuerySession> {
  const config = makeConfig({ options: { ...makeConfig().options, ...options } })
  const session = await QuerySession.open(config, null, TEST_DATABASE, { onLost })
  sessions.push(session)
  return session
}

describe('QuerySession', () => {
  it("keeps a temp table past the shared pool's idle timeout", async () => {
    const session = await openSession(undefined, { poolIdleTimeoutMs: 1000 })
    await session.pool.request().batch('CREATE TABLE #kept (id int)')
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const result = await session.pool.request().query('SELECT COUNT(*) AS n FROM #kept')
    expect(result.recordset[0].n).toBe(0)
  })

  it('reads its state, and when its transaction opened', async () => {
    const session = await openSession()
    expect(session.state).toEqual({ transactionCount: 0, transactionState: 0, database: TEST_DATABASE })
    await session.pool.request().batch('BEGIN TRAN')
    const open = await session.readState()
    expect(open).toMatchObject({ transactionCount: 1, transactionState: 1, database: TEST_DATABASE })
    expect(typeof open.transactionSince).toBe('string')
    await session.pool.request().batch('ROLLBACK')
    expect((await session.readState()).transactionSince).toBeUndefined()
  })

  it('rolls back what is open when it is closed', async () => {
    const session = await openSession()
    await session.pool
      .request()
      .batch("BEGIN TRAN; UPDATE dbo.session_items SET name = N'changed' WHERE id = 1;")
    await session.close()
    expect(await scalar(admin, 'SELECT name FROM dbo.session_items WHERE id = 1')).toBe('original')
  })

  it('is lost, and never replaced, when the server kills it', async () => {
    const reported: SessionState[] = []
    const session = await openSession((had) => reported.push(had))
    await session.pool.request().batch('BEGIN TRAN')
    await session.readState()
    const spid = (await session.pool.request().query('SELECT @@SPID AS spid')).recordset[0].spid
    await admin.runScript(`KILL ${spid}`)
    await until(() => session.lost !== null)
    expect(reported).toHaveLength(1)
    expect(reported[0].transactionCount).toBe(1)
    expect(() => session.pool).toThrow("This tab's session was closed.")
  })
})

describe("a tab's session", () => {
  it('keeps a temp table from one run to the next, with shared reads between, past the idle timeout', async () => {
    const client = await tabClient({ options: { ...makeConfig().options, poolIdleTimeoutMs: 1000 } })
    expect((await client.runInSession('a', 'CREATE TABLE #t (id int)')).statements[0].error).toBeUndefined()
    await Promise.all([
      client.listObjects(),
      client.listRoutines(),
      client.getAutocompleteSchema(),
      client.fetchTableData(ITEMS)
    ])
    expect(first(await client.runInSession('a', 'SELECT COUNT(*) FROM #t'))).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(first(await client.runInSession('a', 'SELECT COUNT(*) FROM #t'))).toBe(0)
  })

  it('keeps USE inside the session', async () => {
    const client = await tabClient()
    expect((await client.runInSession('a', 'USE master')).session?.database).toBe('master')
    const page = await client.fetchTableData(ITEMS)
    expect(page.rows).toHaveLength(2)
    expect((await client.listObjects()).some((o) => o.name === 'session_items')).toBe(true)
  })

  it('keeps an open transaction inside the session, and closing it rolls it back', async () => {
    const client = await tabClient()
    const run = await client.runInSession(
      'a',
      "BEGIN TRAN; UPDATE dbo.session_items SET name = N'changed' WHERE id = 1;"
    )
    expect(run.session).toMatchObject({ transactionCount: 1, transactionState: 1 })
    const [blocked] = await client.runScript(
      'SET LOCK_TIMEOUT 500; SELECT name FROM dbo.session_items WHERE id = 1;'
    )
    expect(blocked.error?.message).toMatch(/lock request time out/i)
    await client.closeSession('a')
    expect(await scalar(client, 'SELECT name FROM dbo.session_items WHERE id = 1')).toBe('original')
  })

  it('reports the transaction a cancelled run left open', async () => {
    const client = await tabClient()
    const running = client.runInSession('a', "BEGIN TRAN; WAITFOR DELAY '00:00:05';", {
      executionId: 'slow'
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(client.cancel('slow')).toBe(true)
    expect((await running).session?.transactionCount).toBe(1)
  })

  it("opens in the window's database when the connection names none", async () => {
    const client = await tabClient({ database: '' })
    expect((await client.runInSession('a', 'SELECT 1')).session?.database).toBe(
      client.info?.currentDatabase
    )
  })

  it('refuses a write on a read-only connection before the session is touched, and lets transactions through', async () => {
    const client = await tabClient({ readOnly: true })
    const refused = await client.runInSession('a', 'DELETE FROM dbo.session_items')
    expect(refused.statements[0].error?.code).toBe(READ_ONLY_CONNECTION)
    expect((await client.runInSession('a', 'BEGIN TRAN; SELECT 1;')).session?.transactionCount).toBe(1)
    expect((await client.runInSession('a', COMMIT_SQL)).session?.transactionCount).toBe(0)
  })

  it('refuses the next run after losing a session that had a transaction open', async () => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    const spid = first(await client.runInSession('a', 'BEGIN TRAN; SELECT @@SPID;'))
    await admin.runScript(`KILL ${spid}`)
    await until(() => changes.some((change) => change.lost))
    const refused = await client.runInSession('a', 'SELECT 1')
    expect(refused.statements[0].error?.code).toBe(SESSION_LOST)
    expect(refused.lost).toMatchObject({ refused: true, had: { transactionCount: 1 } })
    expect(refused.session).toBeNull()
    const next = await client.runInSession('a', 'SELECT 1')
    expect(next.statements[0].error).toBeUndefined()
    expect(next.lost).toBeUndefined()
  })

  it('runs on a new session, saying so, after losing one that had nothing open', async () => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    const spid = first(await client.runInSession('a', 'SELECT @@SPID'))
    await admin.runScript(`KILL ${spid}`)
    await until(() => changes.some((change) => change.lost))
    const run = await client.runInSession('a', 'SELECT 1')
    expect(run.statements[0].error).toBeUndefined()
    expect(run.lost).toMatchObject({ refused: false, had: { transactionCount: 0 } })
  })

  it('loses only the session that was killed', async () => {
    const client = await tabClient()
    const states: string[] = []
    client.onStateChange((event) => states.push(event.state))
    const spid = first(await client.runInSession('a', 'SELECT @@SPID'))
    await client.runInSession('b', 'CREATE TABLE #b (id int)')
    await admin.runScript(`KILL ${spid}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(first(await client.runInSession('b', 'SELECT COUNT(*) FROM #b'))).toBe(0)
    expect(await scalar(client, 'SELECT 1')).toBe(1)
    expect(states).toEqual([])
  })
})

describe('options under which nothing is run', () => {
  // SQL Server compiles what it is sent under these, and runs none of it — the
  // app's own read of where the session stands included. The session is still
  // there, and so is whatever it has open.
  const OPTIONS = ['SHOWPLAN_XML', 'SHOWPLAN_TEXT', 'SHOWPLAN_ALL', 'NOEXEC', 'PARSEONLY']

  it.each(OPTIONS)('keeps the session under SET %s, and runs nothing it is sent', async (option) => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    try {
      const on = await client.runInSession('a', `SET ${option} ON`)
      expect(on.statements[0].error).toBeUndefined()
      expect(on.session).toMatchObject({ transactionCount: 0, database: TEST_DATABASE })
      const update = await client.runInSession(
        'a',
        "UPDATE dbo.session_items SET name = N'executed' WHERE id = 1"
      )
      expect(update.lost).toBeUndefined()
      expect(update.session).toMatchObject({ transactionCount: 0, database: TEST_DATABASE })
      expect(await scalar(admin, 'SELECT name FROM dbo.session_items WHERE id = 1')).toBe('original')
      expect((await client.runInSession('a', `SET ${option} OFF`)).statements[0].error).toBeUndefined()
      expect(first(await client.runInSession('a', 'SELECT 1'))).toBe(1)
      expect(changes.filter((change) => change.lost)).toEqual([])
    } finally {
      await client.closeSession('a')
    }
  })

  it.each(OPTIONS)('keeps an open transaction open under SET %s', async (option) => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    try {
      await client.runInSession(
        'a',
        "BEGIN TRAN; UPDATE dbo.session_items SET name = N'changed' WHERE id = 1;"
      )
      const on = await client.runInSession('a', `SET ${option} ON`)
      expect(on.session).toMatchObject({ transactionCount: 1, transactionState: 1 })
      const under = await client.runInSession('a', 'SELECT 1')
      expect(under.lost).toBeUndefined()
      expect(under.session).toMatchObject({ transactionCount: 1, transactionState: 1 })
      await client.runInSession('a', `SET ${option} OFF`)
      const after = await client.runInSession('a', 'SELECT name FROM dbo.session_items WHERE id = 1')
      expect(first(after)).toBe('changed')
      expect(after.session?.transactionCount).toBe(1)
      expect(changes.filter((change) => change.lost)).toEqual([])
    } finally {
      await client.closeSession('a')
    }
    expect(await scalar(admin, 'SELECT name FROM dbo.session_items WHERE id = 1')).toBe('original')
  })
})

describe('switching database', () => {
  it('moves a following session with the sidebar, and tells the window', async () => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    await client.runInSession('a', 'SELECT 1')
    await client.useDatabase('tv_sessions_other')
    await until(() =>
      changes.some(
        (change) => change.sessionId === 'a' && change.state?.database === 'tv_sessions_other'
      )
    )
    expect(first(await client.runInSession('a', 'SELECT DB_NAME()'))).toBe('tv_sessions_other')
  })

  it('leaves a session in its own database, or in a transaction, where it is', async () => {
    const client = await tabClient()
    await client.runInSession('own', 'USE master')
    await client.runInSession('txn', 'BEGIN TRAN')
    await client.useDatabase('tv_sessions_other')
    expect(first(await client.runInSession('own', 'SELECT DB_NAME()'))).toBe('master')
    expect(first(await client.runInSession('txn', 'SELECT DB_NAME()'))).toBe(TEST_DATABASE)
  })

  it("keeps a routine's tab in the routine's database", async () => {
    const client = await tabClient()
    const pinned = { pinnedDatabase: TEST_DATABASE }
    await client.useDatabase('tv_sessions_other')
    expect(first(await client.runInSession('r', 'SELECT DB_NAME()', pinned))).toBe(TEST_DATABASE)
    await client.useDatabase(TEST_DATABASE)
    await client.useDatabase('tv_sessions_other')
    expect(first(await client.runInSession('r', 'SELECT DB_NAME()', pinned))).toBe(TEST_DATABASE)
  })

  it('follows once a running query ends', async () => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    await client.runInSession('d', 'SELECT 1')
    const running = client.runInSession('d', "WAITFOR DELAY '00:00:02'")
    await new Promise((resolve) => setTimeout(resolve, 300))
    await client.useDatabase('tv_sessions_other')
    // It ran where it was; the move comes after, and says so.
    expect((await running).session?.database).toBe(TEST_DATABASE)
    await until(() => changes.some((change) => change.state?.database === 'tv_sessions_other'))
    expect(first(await client.runInSession('d', 'SELECT DB_NAME()'))).toBe('tv_sessions_other')
  })

  it('answers the switch before its sessions have moved, and moves them side by side', async () => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    for (const id of ['a', 'b', 'c']) await client.runInSession(id, 'SELECT 1')
    const use = QuerySession.prototype.use
    const slow = vi
      .spyOn(QuerySession.prototype, 'use')
      .mockImplementation(async function (this: QuerySession, database: string) {
        // Each move as slow as a round trip down a slow tunnel.
        await new Promise((resolve) => setTimeout(resolve, 500))
        return use.call(this, database)
      })
    try {
      const started = Date.now()
      await client.useDatabase('tv_sessions_other')
      expect(Date.now() - started).toBeLessThan(500)
      const moved = (): number =>
        changes.filter((change) => change.state?.database === 'tv_sessions_other').length
      await until(() => moved() === 3, 1200)
    } finally {
      slow.mockRestore()
    }
  })

  it('runs a query started during a move after it, in the database moved to', async () => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    await client.runInSession('a', 'SELECT 1')
    let moving!: () => void
    const moveStarted = new Promise<void>((resolve) => (moving = resolve))
    const use = QuerySession.prototype.use
    const slow = vi
      .spyOn(QuerySession.prototype, 'use')
      .mockImplementation(async function (this: QuerySession, database: string) {
        moving()
        await new Promise((resolve) => setTimeout(resolve, 300))
        return use.call(this, database)
      })
    try {
      const started = Date.now()
      let answeredAfter = Infinity
      const switching = client.useDatabase('tv_sessions_other').then(() => {
        answeredAfter = Date.now() - started
      })
      await moveStarted
      const run = await client.runInSession(
        'a',
        "BEGIN TRAN; SELECT DB_NAME(); WAITFOR DELAY '00:00:01';"
      )
      await switching
      expect(answeredAfter).toBeLessThan(500)
      expect(first(run)).toBe('tv_sessions_other')
      expect(run.lost).toBeUndefined()
      expect(run.session).toMatchObject({ database: 'tv_sessions_other', transactionCount: 1 })
      expect(changes.filter((change) => change.lost)).toEqual([])
    } finally {
      slow.mockRestore()
      await client.closeSession('a')
    }
  })

  it('quotes a database name that needs it', async () => {
    const client = await tabClient()
    await client.runInSession('a', 'SELECT 1')
    await client.useDatabase('tv sessions]odd')
    expect(first(await client.runInSession('a', 'SELECT DB_NAME()'))).toBe('tv sessions]odd')
  })
})

describe('drops, disconnects and keepalive', () => {
  it('reports every session lost when the connection drops, and holds them to the rule once it is back', async () => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    const back = new Promise<void>((resolve) =>
      client.onStateChange((event) => {
        if (event.state === 'connected') resolve()
      })
    )
    await client.runInSession('txn', 'BEGIN TRAN')
    await client.runInSession('plain', 'SELECT 1')
    // The drop the heartbeat would report, driven through the client's own handling.
    await (client as unknown as { handleDrop(error: unknown): Promise<void> }).handleDrop(
      new Error('socket hang up')
    )
    await back
    expect(
      changes
        .filter((change) => change.lost)
        .map((change) => [change.sessionId, change.lost!.transactionCount])
        .sort()
    ).toEqual([
      ['plain', 0],
      ['txn', 1]
    ])
    expect((await client.runInSession('txn', 'SELECT 1')).statements[0].error?.code).toBe(SESSION_LOST)
    expect((await client.runInSession('plain', 'SELECT 1')).lost?.refused).toBe(false)
  })

  it('closes every session on disconnect', async () => {
    const client = await tabClient({
      options: { ...makeConfig().options, applicationName: 'tv-sessions-disconnect' }
    })
    await client.runInSession('a', 'SELECT 1')
    await client.runInSession('b', 'SELECT 1')
    await client.disconnect()
    expect(await serverSessions('tv-sessions-disconnect')).toBe(0)
  })

  it('heartbeats an idle session, and leaves a busy one alone', async () => {
    const client = await tabClient({ options: { ...makeConfig().options, keepAliveIntervalMs: 200 } })
    await client.runInSession('a', 'SELECT 1')
    const session = (client as unknown as { sessions: Map<string, QuerySession> }).sessions.get('a')!
    await until(() => typeof session.lastHeartbeatAt === 'number', 2000)
    const running = client.runInSession('a', "WAITFOR DELAY '00:00:01.500'")
    await new Promise((resolve) => setTimeout(resolve, 300))
    const during = session.lastHeartbeatAt
    expect(typeof during).toBe('number')
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(session.lastHeartbeatAt).toBe(during)
    await running
  })
})

describe('a session still opening', () => {
  // A session can take a second or more to open through a tunnel, and the tab
  // can be cancelled, closed or disconnected meanwhile.
  const UPDATE =
    "BEGIN TRAN; UPDATE dbo.session_items SET name = N'opening' WHERE id = 1; WAITFOR DELAY '00:00:01';"

  /** Makes every session take `ms` longer to open; returns the undo. */
  function slowOpens(ms: number): () => void {
    const open = QuerySession.open
    const spy = vi.spyOn(QuerySession, 'open').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return open.apply(QuerySession, args)
    })
    return () => spy.mockRestore()
  }

  /** Row 1 as committed — failing rather than waiting if a transaction holds it. */
  function committedName(): Promise<unknown> {
    return scalar(admin, 'SET LOCK_TIMEOUT 1000; SELECT name FROM dbo.session_items WHERE id = 1;')
  }

  it('can be cancelled, and then runs nothing', async () => {
    const client = await tabClient()
    const restore = slowOpens(500)
    const running = client.runInSession('a', UPDATE, { executionId: 'early' })
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(client.cancel('early')).toBe(true)
      const run = await running
      expect(run.statements).toHaveLength(1)
      expect(run.statements[0].error?.message).toMatch(/cancel/i)
      expect(run.session).toMatchObject({ transactionCount: 0 })
      expect(await committedName()).toBe('original')
    } finally {
      restore()
      await running.catch(() => undefined)
      await client.closeSession('a')
    }
  })

  it('is closed once it opens when its tab closed meanwhile, and runs nothing', async () => {
    const client = await tabClient()
    const restore = slowOpens(500)
    const running = client.runInSession('a', UPDATE)
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.closeSession('a')
      const run = await running
      expect(run.statements[0].error).toBeDefined()
      expect(run.session).toBeNull()
      expect((client as unknown as { sessions: Map<string, QuerySession> }).sessions.has('a')).toBe(
        false
      )
      expect(await committedName()).toBe('original')
    } finally {
      restore()
      await running.catch(() => undefined)
      await client.closeSession('a')
    }
  })

  it('is closed once it opens when the connection closed meanwhile, and runs nothing', async () => {
    const program = 'tv-sessions-opening-disconnect'
    const client = await tabClient({ options: { ...makeConfig().options, applicationName: program } })
    const restore = slowOpens(500)
    const running = client.runInSession('a', UPDATE).catch(() => undefined)
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.disconnect()
      await running
      expect(await serverSessions(program)).toBe(0)
      expect(await committedName()).toBe('original')
    } finally {
      restore()
      await running
      await client.disconnect()
    }
  })
})

describe('reconnecting by hand', () => {
  // The Reconnect button opens the connection again with a new client, after
  // the old one gave up on a drop or while it still holds the tabs' sessions.

  /** Row 1 as committed — failing rather than waiting if a transaction holds it. */
  function committedName(): Promise<unknown> {
    return scalar(admin, 'SET LOCK_TIMEOUT 1000; SELECT name FROM dbo.session_items WHERE id = 1;')
  }

  const UPDATE = "UPDATE dbo.session_items SET name = N'autocommitted' WHERE id = 1"

  it('refuses the next run of a tab whose session was lost holding a transaction', async () => {
    const registry = new ConnectionRegistry()
    const config = makeConfig()
    const changes: SessionChange[] = []
    registry.onSessionChange((_scope, _id, change) => changes.push(change))
    try {
      expect((await registry.open('w', config)).state).toBe('connected')
      const spid = first(
        await registry.get('w', config.id).runInSession('t', 'BEGIN TRAN; SELECT @@SPID;')
      )
      await admin.runScript(`KILL ${spid}`)
      await until(() => changes.some((change) => change.lost))
      expect((await registry.open('w', config)).state).toBe('connected')
      const refused = await registry.get('w', config.id).runInSession('t', UPDATE)
      expect(refused.statements[0].error?.code).toBe(SESSION_LOST)
      expect(refused.lost).toMatchObject({ refused: true, had: { transactionCount: 1 } })
      expect(await committedName()).toBe('original')
      const next = await registry.get('w', config.id).runInSession('t', 'SELECT 1')
      expect(next.statements[0].error).toBeUndefined()
      expect(next.lost).toBeUndefined()
    } finally {
      await registry.closeAll()
    }
  })

  it('ends the sessions it replaces, saying so, and refuses the next run of a tab that had a transaction', async () => {
    const registry = new ConnectionRegistry()
    const config = makeConfig()
    const changes: SessionChange[] = []
    registry.onSessionChange((_scope, _id, change) => changes.push(change))
    try {
      await registry.open('w', config)
      await registry
        .get('w', config.id)
        .runInSession('t', "BEGIN TRAN; UPDATE dbo.session_items SET name = N'lost' WHERE id = 1;")
      await registry.open('w', config)
      expect(changes).toContainEqual(
        expect.objectContaining({
          sessionId: 't',
          state: null,
          lost: expect.objectContaining({ transactionCount: 1 })
        })
      )
      const refused = await registry.get('w', config.id).runInSession('t', UPDATE)
      expect(refused.statements[0].error?.code).toBe(SESSION_LOST)
      expect(await committedName()).toBe('original')
    } finally {
      await registry.closeAll()
    }
  })
})

describe('a network gone quiet', () => {
  // A laptop that slept, a VPN that dropped: the sockets stay open and nothing
  // comes back. Closing must not wait out the request timeout.
  it('closes a session, and disconnects, within seconds', async () => {
    let quiet = false
    const sockets = new Set<net.Socket>()
    const proxy = net.createServer((inbound) => {
      const outbound = net.connect(TEST_PORT, TEST_HOST)
      for (const socket of [inbound, outbound]) {
        sockets.add(socket)
        socket.on('error', () => undefined)
      }
      inbound.on('data', (data) => {
        if (!quiet) outbound.write(data)
      })
      outbound.on('data', (data) => {
        if (!quiet) inbound.write(data)
      })
      inbound.on('close', () => outbound.destroy())
      outbound.on('close', () => inbound.destroy())
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const { port } = proxy.address() as net.AddressInfo
    try {
      const client = await tabClient({
        host: '127.0.0.1',
        port,
        options: { ...makeConfig().options, requestTimeoutMs: 8000, keepAliveIntervalMs: 0 }
      })
      await client.runInSession('a', 'BEGIN TRAN; SELECT 1;')
      await client.runInSession('b', 'SELECT 1')
      quiet = true
      let started = Date.now()
      await client.closeSession('a')
      expect(Date.now() - started).toBeLessThan(5000)
      started = Date.now()
      await client.disconnect()
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      for (const socket of sockets) socket.destroy()
      proxy.close()
    }
  })
})
