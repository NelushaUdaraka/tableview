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
import type { ConnectionConfig, SessionState } from '../../src/shared/types'
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
