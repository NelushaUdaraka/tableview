/**
 * A query tab's session, against a real SQL Server.
 *
 * Every run in a tab used to borrow whichever connection the window's pool
 * had free, so a temp table, a `USE` or an open transaction from one run was
 * at the mercy of the next — and of the table tabs and the schema tree, which
 * borrowed from the same pool. Each tab now holds a session of its own; these
 * are the behaviours that make that true.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import { TEST_DATABASE, connectedClient, createTestDatabase, makeConfig } from './helpers'

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

describe('switching database', () => {
  it('moves a following session with the sidebar, and tells the window', async () => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    await client.runInSession('a', 'SELECT 1')
    await client.useDatabase('tv_sessions_other')
    expect(changes).toContainEqual(
      expect.objectContaining({
        sessionId: 'a',
        state: expect.objectContaining({ database: 'tv_sessions_other' })
      })
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
    await client.runInSession('d', 'SELECT 1')
    const running = client.runInSession('d', "WAITFOR DELAY '00:00:02'")
    await new Promise((resolve) => setTimeout(resolve, 300))
    await client.useDatabase('tv_sessions_other')
    expect((await running).session?.database).toBe('tv_sessions_other')
  })

  it('quotes a database name that needs it', async () => {
    const client = await tabClient()
    await client.runInSession('a', 'SELECT 1')
    await client.useDatabase('tv sessions]odd')
    expect(first(await client.runInSession('a', 'SELECT DB_NAME()'))).toBe('tv sessions]odd')
  })
})
