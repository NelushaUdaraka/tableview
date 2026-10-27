/**
 * The activity monitor against a real SQL Server: a transaction left open on
 * one connection blocking a read on another, seen as a chain, and ended with
 * Kill — the situation the monitor exists to find.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'
import { READ_ONLY_CONNECTION, type ServerActivity } from '../../src/shared/types'
import { connectedClient, createTestDatabase } from './helpers'

let admin: SqlServerClient
let holder: SqlServerClient
let waiter: SqlServerClient

beforeAll(async () => {
  await createTestDatabase()
  admin = await connectedClient()
  holder = await connectedClient()
  waiter = await connectedClient()
  const [seeded] = await admin.runScript(`
    IF OBJECT_ID('dbo.activity_items') IS NOT NULL DROP TABLE dbo.activity_items;
    CREATE TABLE dbo.activity_items (id int PRIMARY KEY, name nvarchar(50));
    INSERT dbo.activity_items VALUES (1, N'a'), (2, N'b');`)
  expect(seeded.error).toBeUndefined()
}, 180000)

afterAll(async () => {
  for (const client of [holder, waiter, admin]) await client?.disconnect().catch(() => undefined)
})

async function waitForActivity(
  check: (activity: ServerActivity) => boolean,
  ms = 20000
): Promise<ServerActivity> {
  const end = Date.now() + ms
  let last = await admin.readActivity()
  while (!check(last)) {
    if (Date.now() > end) throw new Error(`activity never matched: ${JSON.stringify(last.sessions)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
    last = await admin.readActivity()
  }
  return last
}

describe('readActivity', () => {
  it("lists user sessions, with the monitor's own and this process's marked", async () => {
    const activity = await admin.readActivity()
    expect(activity.missingPermission).toBeUndefined()
    const monitor = activity.sessions.find((session) => session.sessionId === activity.monitorSessionId)
    expect(monitor).toBeDefined()
    expect(monitor!.ownProcess).toBe(true)
    expect(monitor!.sqlIsCurrent).toBe(true)
  })

  it('shows a blocked read waiting on an idle session holding a transaction, and Kill ends it', async () => {
    const held = await holder.runInSession(
      'holder',
      "BEGIN TRAN; UPDATE dbo.activity_items SET name = N'held' WHERE id = 1;"
    )
    expect(held.session?.transactionCount).toBe(1)

    // Blocks on the row the holder has locked, until the holder goes.
    const blocked = waiter.runInSession('waiter', 'SELECT name FROM dbo.activity_items WHERE id = 1;')

    const activity = await waitForActivity((now) =>
      now.sessions.some((session) => session.blockedBy !== null && session.sql?.includes('activity_items'))
    )
    const victim = activity.sessions.find((session) => session.blockedBy !== null)!
    const head = activity.sessions.find((session) => session.sessionId === victim.blockedBy)!
    expect(victim.status).toBe('suspended')
    expect(victim.waitType).toMatch(/^LCK_M_/)
    expect(head.openTransactions).toBe(1)
    expect(head.sqlIsCurrent).toBe(false)
    expect(head.ownProcess).toBe(true)
    // An idle tab's last statement is the app's own state read, so the tab
    // it is matters more — and the holder's client knows its tab's session.
    const ofHolder = await holder.readActivity()
    expect(ofHolder.tabSessions[head.sessionId]).toBe('holder')
    expect(ofHolder.sessions.find((s) => s.sessionId === head.sessionId)?.sql).toContain("SET name = N'held'")
    expect(head.sql).toBeNull()
    expect(activity.tabSessions[head.sessionId]).toBeUndefined()

    await admin.killSession(head.sessionId)
    const [read] = (await blocked).statements
    expect(read.error).toBeUndefined()
    // The killed session's transaction was rolled back.
    expect(read.resultSets[0].rows).toEqual([['a']])
  }, 60000)

  it('refuses to kill on a read-only connection', async () => {
    const readOnly = await connectedClient({ readOnly: true })
    try {
      await expect(readOnly.killSession(999)).rejects.toMatchObject({ code: READ_ONLY_CONNECTION })
    } finally {
      await readOnly.disconnect()
    }
  })

  it('says so when the session to kill is not there', async () => {
    await expect(admin.killSession(32000)).rejects.toThrow(/not an active process|32000/i)
  })
})
