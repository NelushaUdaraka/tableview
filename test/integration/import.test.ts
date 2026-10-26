/**
 * Rows from a CSV file, against a real SQL Server: read and converted the way
 * the import dialog does it, staged as inserts, and applied in one
 * transaction — thousands of them in a few multi-row statements, all or none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'
import { parseDelimited } from '../../src/shared/csv'
import { importableColumns, matchColumns, planImport } from '../../src/shared/import'
import { buildChangeSetStatements } from '../../src/shared/sql/builder'
import { changeSetScript } from '../../src/shared/sql/changeScript'
import type { TableChangeSet } from '../../src/shared/types'
import { connectedClient, createTestDatabase } from './helpers'

let client: SqlServerClient

beforeAll(async () => {
  await createTestDatabase()
  client = await connectedClient()
  const [created] = await client.runScript(`
    IF OBJECT_ID('dbo.import_people') IS NOT NULL DROP TABLE dbo.import_people;
    CREATE TABLE dbo.import_people (
      id int IDENTITY(1,1) PRIMARY KEY,
      email nvarchar(80) NOT NULL UNIQUE,
      credit decimal(10, 2) NOT NULL DEFAULT (0),
      active bit NULL,
      joined date NULL,
      big bigint NULL,
      stamp rowversion
    );`)
  expect(created.error).toBeUndefined()
}, 180000)

afterAll(async () => {
  await client?.runScript('DROP TABLE IF EXISTS dbo.import_people').catch(() => undefined)
  await client?.disconnect()
})

async function count(): Promise<number> {
  const [result] = await client.runScript('SELECT COUNT(*) FROM dbo.import_people')
  return Number(result.resultSets[0].rows[0][0])
}

function changeSet(rows: Record<string, unknown>[]): TableChangeSet {
  return {
    connectionId: 'test-connection',
    schema: 'dbo',
    table: 'import_people',
    inserts: rows.map((values, index) => ({ tempId: `new-${index}`, values: values as never })),
    updates: [],
    deletes: []
  }
}

describe('importing a CSV file', () => {
  it('converts a file and applies its rows exactly, defaults and all', async () => {
    const structure = await client.getTableStructure('dbo', 'import_people')
    const columns = importableColumns(structure.columns)
    expect(columns.map((c) => c.name)).toEqual(['email', 'credit', 'active', 'joined', 'big'])

    const csv = 'Email;Credit;Active;Joined;Big\r\nada@example.com;1234.56;yes;2024-03-01;9007199254740993\r\n' +
      'grace@example.com;;0;;\r\n'
    const { rows } = parseDelimited(csv)
    const plan = planImport(rows, {
      header: true,
      mapping: matchColumns(rows[0], columns),
      columns,
      emptyAs: 'null'
    })
    expect(plan.problems).toEqual([])
    const applied = await client.applyChanges(changeSet(plan.rows.map((row) => row.values)))
    expect(applied.inserted).toBe(2)

    const [read] = await client.runScript(
      'SELECT email, credit, active, CONVERT(char(10), joined, 23), CAST(big AS varchar(30)) FROM dbo.import_people ORDER BY id'
    )
    expect(read.resultSets[0].rows).toEqual([
      ['ada@example.com', 1234.56, true, '2024-03-01', '9007199254740993'],
      // The empty credit took the column's default rather than a NULL.
      ['grace@example.com', 0, false, null, null]
    ])
  })

  it('sends thousands of rows in a few statements, inside one transaction', async () => {
    const before = await count()
    const rows = Array.from({ length: 3000 }, (_, index) => ({
      email: `bulk${index}@example.com`,
      credit: `${index}.25`
    }))
    expect(buildChangeSetStatements(changeSet(rows))).toHaveLength(3)
    const applied = await client.applyChanges(changeSet(rows))
    expect(applied.inserted).toBe(3000)
    expect(await count()).toBe(before + 3000)
  }, 60000)

  it('applies none of them when one row is refused', async () => {
    const before = await count()
    const rows = Array.from({ length: 1500 }, (_, index) => ({ email: `again${index}@example.com` }))
    rows[1200] = { email: 'ada@example.com' } // already there: the UNIQUE key refuses it
    await expect(client.applyChanges(changeSet(rows))).rejects.toThrow(/UNIQUE KEY|duplicate key/i)
    expect(await count()).toBe(before)
  }, 60000)

  it('copies as a script that runs the same multi-row inserts', async () => {
    const before = await count()
    const script = changeSetScript(
      changeSet([{ email: "o'brien@example.com", credit: '1.50' }, { email: 'x@example.com', credit: '2' }])
    )
    expect(script).toContain("VALUES\n  (N'o''brien@example.com', N'1.50'),\n  (N'x@example.com', N'2')")
    const results = await client.runScript(script)
    expect(results.find((result) => result.error)).toBeUndefined()
    expect(await count()).toBe(before + 2)
  })
})
