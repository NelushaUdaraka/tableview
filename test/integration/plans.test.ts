/**
 * Execution plans on a query tab's session, against a real SQL Server: an
 * estimated plan compiles without running anything, an actual one runs and
 * returns each statement's plan, and either way the session is left as it
 * was — never stuck compiling without running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'
import { liftPlans, parseShowplan } from '../../src/shared/showplan'
import { READ_ONLY_CONNECTION } from '../../src/shared/types'
import { connectedClient, createTestDatabase } from './helpers'

let client: SqlServerClient
let readOnly: SqlServerClient

beforeAll(async () => {
  await createTestDatabase()
  client = await connectedClient()
  readOnly = await connectedClient({ readOnly: true })
  const [seeded] = await client.runScript(`
    IF OBJECT_ID('dbo.plan_items') IS NOT NULL DROP TABLE dbo.plan_items;
    CREATE TABLE dbo.plan_items (id int PRIMARY KEY, code varchar(10) NOT NULL);
    INSERT dbo.plan_items VALUES (1, 'a'), (2, 'b'), (3, 'c');`)
  expect(seeded.error).toBeUndefined()
}, 180000)

afterAll(async () => {
  await client?.runScript('DROP TABLE IF EXISTS dbo.plan_items').catch(() => undefined)
  await readOnly?.disconnect()
  await client?.disconnect()
})

async function count(): Promise<number> {
  const [result] = await client.runScript('SELECT COUNT(*) FROM dbo.plan_items')
  return Number(result.resultSets[0].rows[0][0])
}

describe('an estimated plan', () => {
  it('compiles the script without running it, one plan per batch', async () => {
    const run = await client.runInSession('est', 'DELETE FROM dbo.plan_items WHERE id = 1;\nGO\nSELECT * FROM dbo.plan_items', {
      plan: 'estimated'
    })
    const { statements, plans } = liftPlans(run.statements)
    expect(statements.every((statement) => !statement.error && statement.resultSets.length === 0)).toBe(true)
    expect(plans).toHaveLength(2)
    expect(parseShowplan(plans[0])[0].type).toBe('DELETE')
    expect(parseShowplan(plans[1])[0].root?.physicalOp).toBe('Clustered Index Scan')
    expect(await count()).toBe(3)

    // The session runs normally afterwards.
    const after = await client.runInSession('est', 'SELECT COUNT(*) FROM dbo.plan_items')
    expect(after.statements[0].resultSets[0].rows).toEqual([[3]])
  })

  it('turns showplan off again after a batch that fails to compile', async () => {
    const run = await client.runInSession('est', 'SELECT * FROM dbo.no_such_table', { plan: 'estimated' })
    expect(run.statements[0].error?.message).toMatch(/Invalid object name/)
    const after = await client.runInSession('est', 'SELECT 1 AS one')
    expect(after.statements[0].resultSets[0].rows).toEqual([[1]])
  })

  it('is allowed on a read-only connection for a write, since nothing runs', async () => {
    const run = await readOnly.runInSession('ro', "UPDATE dbo.plan_items SET code = 'z'", {
      plan: 'estimated'
    })
    const { plans } = liftPlans(run.statements)
    expect(plans).toHaveLength(1)
    expect(parseShowplan(plans[0])[0].type).toBe('UPDATE')
    const [check] = await client.runScript("SELECT COUNT(*) FROM dbo.plan_items WHERE code = 'z'")
    expect(check.resultSets[0].rows).toEqual([[0]])
  })

  it('is refused on a read-only connection when the script switches showplan off itself', async () => {
    const run = await readOnly.runInSession(
      'ro',
      'SET SHOWPLAN_XML OFF;\nDELETE FROM dbo.plan_items',
      { plan: 'estimated' }
    )
    expect(run.statements[0].error?.code).toBe(READ_ONLY_CONNECTION)
    expect(await count()).toBe(3)
  })
})

describe('an actual plan', () => {
  it('runs the script and returns a plan per statement beside its rows', async () => {
    const run = await client.runInSession('act', "SELECT code FROM dbo.plan_items WHERE id = 2;\nSELECT COUNT(*) FROM dbo.plan_items", {
      plan: 'actual'
    })
    const { statements, plans } = liftPlans(run.statements)
    expect(statements[0].resultSets.map((set) => set.rows)).toEqual([[['b']], [[3]]])
    expect(plans).toHaveLength(2)
    const [first] = parseShowplan(plans[0])
    expect(first.actual).toBe(true)
    expect(first.root?.actualRows).toBe(1)

    // And it is off again: the next run returns rows and no plan.
    const after = liftPlans((await client.runInSession('act', 'SELECT 1 AS one')).statements)
    expect(after.plans).toEqual([])
  })

  it('is held to the read-only check, since it runs the script', async () => {
    const run = await readOnly.runInSession('ro2', 'DELETE FROM dbo.plan_items', { plan: 'actual' })
    expect(run.statements[0].error?.code).toBe(READ_ONLY_CONNECTION)
  })
})
