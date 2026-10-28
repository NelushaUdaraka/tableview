import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'
import { buildCreateTableDdl } from '../../src/shared/sql/builder'
import { CERTIFICATE_NOT_TRUSTED, isTagged } from '../../src/shared/types'
import { connectedClient, createTestDatabase, seedTestDatabase } from './helpers'

let client: SqlServerClient

beforeAll(async () => {
  await createTestDatabase()
  client = await connectedClient()
  await seedTestDatabase(client)
}, 180000)

afterAll(async () => {
  await client?.disconnect()
})

describe('connection', () => {
  it('reports server information', () => {
    const info = client.info
    expect(info).not.toBeNull()
    expect(info!.productVersion).toMatch(/^\d+\./)
    expect(info!.edition).toMatch(/Edition/i)
    expect(info!.currentDatabase).toBe('beekeeper_test')
    expect(client.isConnected).toBe(true)
  })

  it('fails with a useful error on a bad password', async () => {
    const bad = new SqlServerClient({
      ...client.currentConfig,
      password: 'definitely-not-the-password'
    })
    await expect(bad.connect()).rejects.toThrow(/login failed/i)
    await bad.disconnect()
  })

  // The test server's certificate is self-signed, as most private ones are.
  it('turns down a certificate it cannot check, and says how to trust it', async () => {
    const strict = new SqlServerClient({
      ...client.currentConfig,
      options: { ...client.currentConfig.options, trustServerCertificate: false }
    })
    await expect(strict.connect()).rejects.toThrow(/self-signed certificate.*Trust server certificate/s)
    // Coded, so the window can offer to trust it rather than match on the words.
    await expect(strict.connect()).rejects.toMatchObject({ code: CERTIFICATE_NOT_TRUSTED })
    await strict.disconnect()
  })

  it('fails fast on an unreachable host', async () => {
    const bad = new SqlServerClient({
      ...client.currentConfig,
      host: '127.0.0.1',
      port: 1,
      options: { ...client.currentConfig.options, connectTimeoutMs: 3000 }
    })
    await expect(bad.connect()).rejects.toThrow()
    await bad.disconnect()
  })
  it('switches database, and stays where it was when the new one cannot be opened', async () => {
    const other = new SqlServerClient(client.currentConfig)
    await other.connect()
    try {
      await other.useDatabase('master')
      expect(other.info!.currentDatabase).toBe('master')
      await expect(other.useDatabase('tableview_no_such_database')).rejects.toThrow()
      // Still connected, still in master: the refused switch replaced nothing.
      expect(other.isConnected).toBe(true)
      expect(other.currentConfig.database).toBe('master')
      const [result] = await other.runScript('SELECT DB_NAME() AS db')
      expect(result.resultSets[0].rows[0][0]).toBe('master')
    } finally {
      await other.disconnect()
    }
  })
})

describe('query execution', () => {
  it('returns rows with typed column metadata', async () => {
    const [result] = await client.runScript('SELECT customer_id, email, is_active FROM dbo.customers ORDER BY customer_id')
    expect(result.error).toBeUndefined()
    expect(result.resultSets).toHaveLength(1)

    const set = result.resultSets[0]
    expect(set.columns.map((c) => c.name)).toEqual(['customer_id', 'email', 'is_active'])
    expect(set.columns[0].dataType).toBe('int')
    expect(set.columns[0].jsKind).toBe('number')
    expect(set.columns[1].dataType).toBe('nvarchar(255)')
    expect(set.columns[2].jsKind).toBe('boolean')
    expect(set.rows).toHaveLength(4)
    expect(set.rows[0][1]).toBe('ada@example.com')
    expect(set.rows[0][2]).toBe(true)
  })

  it('returns several result sets from one batch', async () => {
    const [result] = await client.runScript('SELECT 1 AS a; SELECT 2 AS b; SELECT 3 AS c;')
    expect(result.error).toBeUndefined()
    expect(result.resultSets).toHaveLength(3)
    expect(result.resultSets[2].rows[0][0]).toBe(3)
  })

  it('keeps a BEGIN…END body in one batch', async () => {
    const results = await client.runScript(`
      DECLARE @i int = 0;
      IF 1 = 1
      BEGIN
        SET @i = 41;
        SET @i = @i + 1;
      END
      SELECT @i AS answer;
    `)
    expect(results).toHaveLength(1)
    expect(results[0].error).toBeUndefined()
    expect(results[0].resultSets[0].rows[0][0]).toBe(42)
  })

  it('splits batches on GO and runs them in order', async () => {
    const results = await client.runScript('SELECT 1 AS a\nGO\nSELECT 2 AS b\nGO')
    expect(results).toHaveLength(2)
    expect(results[0].resultSets[0].rows[0][0]).toBe(1)
    expect(results[1].resultSets[0].rows[0][0]).toBe(2)
  })

  it('repeats a batch for GO <count>', async () => {
    const results = await client.runScript('SELECT 7 AS n\nGO 3')
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.resultSets[0].rows[0][0] === 7)).toBe(true)
  })

  it('reports rows affected for DML', async () => {
    const results = await client.runScript(`
      CREATE TABLE #tmp (id int);
      INSERT INTO #tmp VALUES (1), (2), (3);
      UPDATE #tmp SET id = id + 1 WHERE id > 1;
      DELETE FROM #tmp WHERE id = 4;
      DROP TABLE #tmp;
    `)
    expect(results[0].error).toBeUndefined()
    expect(results[0].rowsAffected).toEqual(expect.arrayContaining([3, 2, 1]))
  })

  it('captures PRINT output as messages', async () => {
    const [result] = await client.runScript("PRINT 'hello from the server'; SELECT 1 AS x;")
    expect(result.error).toBeUndefined()
    expect(result.messages.map((m) => m.message)).toContain('hello from the server')
  })

  it('surfaces a T-SQL error with its number and line', async () => {
    const [result] = await client.runScript('SELECT * FROM dbo.this_table_is_missing')
    expect(result.error).toBeDefined()
    expect(result.error!.message).toMatch(/Invalid object name/i)
    expect(result.error!.number).toBe(208)
  })

  it('stops the script at the first failing batch', async () => {
    const results = await client.runScript('SELECT 1 AS ok\nGO\nSELECT * FROM nope\nGO\nSELECT 3 AS never')
    expect(results).toHaveLength(2)
    expect(results[0].error).toBeUndefined()
    expect(results[1].error).toBeDefined()
  })

  it('creates a procedure, which must start its own batch', async () => {
    const results = await client.runScript(`
      IF OBJECT_ID('dbo.sp_beekeeper_demo', 'P') IS NOT NULL DROP PROCEDURE dbo.sp_beekeeper_demo;
      GO
      CREATE PROCEDURE dbo.sp_beekeeper_demo AS
      BEGIN
        SET NOCOUNT ON;
        SELECT 'from procedure' AS source;
      END
      GO
      EXEC dbo.sp_beekeeper_demo;
    `)
    expect(results.map((r) => r.error?.message).filter(Boolean)).toEqual([])
    const last = results[results.length - 1]
    expect(last.resultSets[0].rows[0][0]).toBe('from procedure')
  })

  it('caps rows at maxRows and flags truncation', async () => {
    const [result] = await client.runScript(
      'SELECT TOP (50) object_id FROM sys.all_objects ORDER BY object_id',
      { maxRows: 10 }
    )
    const set = result.resultSets[0]
    expect(set.rows).toHaveLength(10)
    expect(set.rowCount).toBe(50)
    expect(set.truncated).toBe(true)
  })
})

describe('value serialisation', () => {
  it('round-trips every column type in wide_types', async () => {
    const [result] = await client.runScript('SELECT * FROM dbo.wide_types WHERE id = 1')
    const set = result.resultSets[0]
    const byName = Object.fromEntries(set.columns.map((c, i) => [c.name, set.rows[0][i]]))
    const typeByName = Object.fromEntries(set.columns.map((c) => [c.name, c.dataType]))

    expect(typeByName.c_varchar).toBe('varchar(50)')
    expect(typeByName.c_nvarchar).toBe('nvarchar(50)')
    expect(typeByName.c_varchar_max).toBe('varchar(max)')
    expect(typeByName.c_nvarchar_max).toBe('nvarchar(max)')
    expect(typeByName.c_decimal).toBe('decimal(18, 4)')
    expect(typeByName.c_binary).toBe('binary(4)')
    expect(typeByName.c_time).toBe('time(3)')

    expect(byName.c_smallint).toBe(32767)
    expect(byName.c_tinyint).toBe(255)
    expect(byName.c_bit).toBe(true)
    expect(byName.c_varchar).toBe('varchar value')
    expect(byName.c_nvarchar).toBe('nvarchar ünïcodé')
    expect(String(byName.c_char)).toBe('abcde')

    // Dates arrive tagged so the renderer can format them without guessing.
    expect(isTagged(byName.c_date)).toBe(true)
    expect((byName.c_date as { t: string; v: string }).t).toBe('date')
    expect((byName.c_date as { v: string }).v).toMatch(/^2024-06-01T/)

    // Binary arrives as hex.
    expect(isTagged(byName.c_binary)).toBe(true)
    expect((byName.c_binary as { t: string; v: string }).t).toBe('bytes')
    expect((byName.c_binary as { v: string }).v).toBe('deadbeef')

    expect(String(byName.c_uniqueidentifier).toUpperCase()).toBe(
      '6F9619FF-8B86-D011-B42D-00C04FC964FF'
    )
    expect(byName.c_xml).toBe('<root a="1"/>')
    // bigint exceeds Number.MAX_SAFE_INTEGER, so the driver preserves it as text.
    expect(byName.c_bigint).toBe('9007199254740993')
    expect(byName.c_computed).toBe('18014398509481986')
  })

  it('represents NULL as null, not as a tagged value', async () => {
    const [result] = await client.runScript('SELECT c_varchar, c_date, c_binary FROM dbo.wide_types WHERE id = 2')
    expect(result.resultSets[0].rows[0]).toEqual([null, null, null])
  })

  it('marks rowversion columns read-only', async () => {
    const [result] = await client.runScript('SELECT c_rowversion FROM dbo.wide_types WHERE id = 1')
    expect(result.resultSets[0].columns[0].isReadOnly).toBe(true)
  })

  it('flags identity columns in result metadata', async () => {
    const [result] = await client.runScript('SELECT customer_id FROM dbo.customers')
    expect(result.resultSets[0].columns[0].isIdentity).toBe(true)
  })
})

describe('schema introspection', () => {
  it('lists databases and marks the system ones', async () => {
    const databases = await client.listDatabases()
    const names = databases.map((d) => d.name)
    expect(names).toContain('beekeeper_test')
    expect(names).toContain('master')
    expect(databases.find((d) => d.name === 'master')!.isSystem).toBe(true)
    expect(databases.find((d) => d.name === 'beekeeper_test')!.isSystem).toBe(false)
  })

  it('lists user tables and views with row estimates', async () => {
    const objects = await client.listObjects()
    const customers = objects.find((o) => o.schema === 'dbo' && o.name === 'customers')
    expect(customers).toBeDefined()
    expect(customers!.type).toBe('table')
    expect(customers!.rowCountEstimate).toBe(4)

    const view = objects.find((o) => o.name === 'customer_summary')
    expect(view!.type).toBe('view')

    // System tables must not leak into the sidebar.
    expect(objects.some((o) => o.schema === 'sys')).toBe(false)
  })

  it('lists schemas including quoted ones', async () => {
    const schemas = await client.listSchemas()
    expect(schemas).toEqual(expect.arrayContaining(['dbo', 'sales', 'odd name']))
  })

  it('lists procedures and functions', async () => {
    const routines = await client.listRoutines()
    expect(routines.some((r) => r.name === 'sp_beekeeper_demo' && r.type === 'procedure')).toBe(true)
  })

  it('describes columns with identity, default, computed and PK flags', async () => {
    const structure = await client.getTableStructure('dbo', 'customers')
    expect(structure.primaryKey).toEqual(['customer_id'])

    const id = structure.columns.find((c) => c.name === 'customer_id')!
    expect(id.isIdentity).toBe(true)
    expect(id.identitySeed).toBe('1')
    expect(id.isPrimaryKey).toBe(true)
    expect(id.nullable).toBe(false)

    const email = structure.columns.find((c) => c.name === 'email')!
    expect(email.fullType).toBe('nvarchar(255)')
    expect(email.nullable).toBe(false)

    const credit = structure.columns.find((c) => c.name === 'credit_limit')!
    expect(credit.fullType).toBe('decimal(18, 2)')
    expect(credit.defaultValue).toBe('((0))')

    expect(structure.rowCountEstimate).toBe(4)
  })

  it('describes computed columns', async () => {
    const structure = await client.getTableStructure('dbo', 'wide_types')
    const computed = structure.columns.find((c) => c.name === 'c_computed')!
    expect(computed.isComputed).toBe(true)
    expect(computed.computedDefinition).toContain('c_bigint')
  })

  it('describes indexes including filtered and included columns', async () => {
    const structure = await client.getTableStructure('dbo', 'customers')
    const index = structure.indexes.find((i) => i.name === 'IX_customers_name')!
    expect(index.isUnique).toBe(false)
    expect(index.isClustered).toBe(false)
    expect(index.filterDefinition).toContain('is_active')

    const key = index.columns.find((c) => c.name === 'display_name')!
    expect(key.descending).toBe(true)
    expect(key.isIncluded).toBe(false)
    expect(index.columns.find((c) => c.name === 'email')!.isIncluded).toBe(true)

    expect(structure.indexes.find((i) => i.isPrimaryKey)!.name).toBe('PK_customers')
  })

  it('describes foreign keys in both directions', async () => {
    const orders = await client.getTableStructure('sales', 'orders')
    const fk = orders.foreignKeys.find((f) => f.name === 'FK_orders_customers')!
    expect(fk.columns).toEqual(['customer_id'])
    expect(fk.referencedSchema).toBe('dbo')
    expect(fk.referencedTable).toBe('customers')
    expect(fk.referencedColumns).toEqual(['customer_id'])
    expect(fk.onDelete).toBe('CASCADE')

    const inbound = await client.getInboundForeignKeys('dbo', 'customers')
    expect(inbound.some((f) => f.referencedTable === 'orders')).toBe(true)
  })

  it('groups composite foreign keys into one entry', async () => {
    const items = await client.getTableStructure('sales', 'order_items')
    expect(items.primaryKey).toEqual(['order_id', 'line_no'])
    expect(items.foreignKeys).toHaveLength(1)
    expect(items.foreignKeys[0].columns).toEqual(['order_id'])
  })

  it('describes triggers and constraints', async () => {
    const structure = await client.getTableStructure('dbo', 'customers')
    const trigger = structure.triggers.find((t) => t.name === 'trg_customers_audit')!
    expect(trigger.events.sort()).toEqual(['INSERT', 'UPDATE'])
    expect(trigger.isInsteadOf).toBe(false)

    expect(structure.constraints.some((c) => c.type === 'check' && c.name === 'CK_customers_credit')).toBe(true)
    expect(structure.constraints.some((c) => c.type === 'unique' && c.name === 'UQ_customers_email')).toBe(true)
    expect(structure.constraints.some((c) => c.type === 'default' && c.column === 'credit_limit')).toBe(true)
  })

  it('handles schemas and tables with brackets and spaces in their names', async () => {
    const structure = await client.getTableStructure('odd name', 'weird ] table')
    expect(structure.columns.map((c) => c.name)).toEqual(['id ] col', "value's"])
    expect(structure.primaryKey).toEqual(['id ] col'])
  })

  it('returns a view definition', async () => {
    const definition = await client.getObjectDefinition('dbo', 'customer_summary')
    expect(definition).toContain('CREATE VIEW')
    expect(definition).toContain('order_count')
  })

  it('generates DDL that recreates the table', async () => {
    const structure = await client.getTableStructure('dbo', 'customers')
    const ddl = buildCreateTableDdl(structure)
    expect(ddl).toContain('CREATE TABLE [dbo].[customers]')
    expect(ddl).toMatch(/\[email\] nvarchar\(255\).*NOT NULL/)
    expect(ddl).toContain('IDENTITY(1, 1)')
    expect(ddl).toContain('CONSTRAINT [PK_customers] PRIMARY KEY CLUSTERED ([customer_id])')

    // The generated DDL must actually run.
    const rerun = ddl.replace('[dbo].[customers]', '[dbo].[customers_ddl_copy]')
      .replace(/CONSTRAINT \[(PK_customers|CK_customers_credit|UQ_customers_email)\]/g, 'CONSTRAINT [$1_copy]')
      .replace(/\[IX_customers_name\]/g, '[IX_customers_name_copy]')
      .replace(/ON \[dbo\]\.\[customers\]/g, 'ON [dbo].[customers_ddl_copy]')
    const results = await client.runScript(
      `IF OBJECT_ID('dbo.customers_ddl_copy','U') IS NOT NULL DROP TABLE dbo.customers_ddl_copy;\nGO\n${rerun}`
    )
    expect(results.map((r) => r.error?.message).filter(Boolean)).toEqual([])
    await client.runScript('DROP TABLE dbo.customers_ddl_copy')
  })
})

describe('searching definitions', () => {
  beforeAll(async () => {
    const results = await client.runScript(`
CREATE OR ALTER PROCEDURE dbo.usp_search_orders AS
BEGIN
  SELECT order_id, Total FROM sales.orders;
END
GO
CREATE OR ALTER PROCEDURE dbo.usp_search_unqualified AS
  SELECT email FROM customers;
GO
CREATE OR ALTER PROCEDURE dbo.usp_search_hidden WITH ENCRYPTION AS
  SELECT 1 AS hidden_100_percent;
GO`)
    expect(results.every((result) => !result.error)).toBe(true)
  })

  it('finds text in procedures and views, with the lines it is on', async () => {
    const { matches } = await client.searchDefinitions({ text: 'sales.orders' })
    const proc = matches.find((match) => match.name === 'usp_search_orders')
    expect(proc?.type).toBe('procedure')
    expect(proc?.lines.map((line) => line.line)).toEqual([3])
    expect(matches.find((match) => match.name === 'customer_summary')?.type).toBe('view')
  })

  it('matches case only when asked to', async () => {
    const loose = await client.searchDefinitions({ text: 'TOTAL' })
    expect(loose.matches.some((match) => match.name === 'usp_search_orders')).toBe(true)
    const strict = await client.searchDefinitions({ text: 'TOTAL', matchCase: true })
    expect(strict.matches.some((match) => match.name === 'usp_search_orders')).toBe(false)
  })

  it('treats LIKE wildcards in the text literally', async () => {
    const { matches } = await client.searchDefinitions({ text: 'order[_]id' })
    expect(matches).toEqual([])
  })

  it('searches only the kinds asked for', async () => {
    const { matches } = await client.searchDefinitions({ text: 'sales.orders', kinds: ['view'] })
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.every((match) => match.type === 'view')).toBe(true)
  })

  it('lists encrypted modules as unsearchable rather than dropping them', async () => {
    const result = await client.searchDefinitions({ text: 'hidden_100_percent' })
    expect(result.matches).toEqual([])
    expect(result.unsearchable).toContainEqual({
      schema: 'dbo',
      name: 'usp_search_hidden',
      type: 'procedure'
    })
  })

  it('finds what uses a table, by id or by a name left without its schema', async () => {
    const orders = await client.findReferences('sales', 'orders')
    const names = orders.matches.map((match) => match.name)
    expect(names).toEqual(expect.arrayContaining(['customer_summary', 'usp_search_orders']))
    expect(orders.matches.find((match) => match.name === 'usp_search_orders')?.lines[0].line).toBe(3)

    const customers = await client.findReferences('dbo', 'customers')
    expect(customers.matches.map((match) => match.name)).toEqual(
      expect.arrayContaining(['customer_summary', 'usp_search_unqualified'])
    )
  })
})
