import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'
import type { TableDataRequest } from '../../src/shared/types'
import { connectedClient, createTestDatabase, seedTestDatabase } from './helpers'

let client: SqlServerClient

function request(overrides: Partial<TableDataRequest> = {}): TableDataRequest {
  return {
    connectionId: 'test-connection',
    schema: 'dbo',
    table: 'customers',
    offset: 0,
    limit: 100,
    sorts: [{ column: 'customer_id', direction: 'asc' }],
    filters: [],
    filterMode: 'builder',
    ...overrides
  }
}

/** Column index lookup, since rows come back as arrays. */
function indexOf(columns: { name: string }[], name: string): number {
  const index = columns.findIndex((column) => column.name === name)
  if (index < 0) throw new Error(`No column named ${name}`)
  return index
}

beforeAll(async () => {
  await createTestDatabase()
  client = await connectedClient()
  await seedTestDatabase(client)
}, 180000)

afterAll(async () => {
  await client?.disconnect()
})

describe('browsing table data', () => {
  it('returns rows, columns and a total count', async () => {
    const response = await client.fetchTableData(request())
    expect(response.rows).toHaveLength(4)
    expect(response.totalRows).toBe(4)
    expect(response.columns.map((c) => c.name)).toContain('email')
    expect(response.sql).toContain('OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY')
  })

  it('pages with offset and limit', async () => {
    const page1 = await client.fetchTableData(request({ offset: 0, limit: 2 }))
    const page2 = await client.fetchTableData(request({ offset: 2, limit: 2 }))
    expect(page1.rows).toHaveLength(2)
    expect(page2.rows).toHaveLength(2)
    expect(page1.rows[0][0]).toBe(1)
    expect(page2.rows[0][0]).toBe(3)
    expect(page2.totalRows).toBe(4)
  })

  it('sorts descending and on multiple columns', async () => {
    const response = await client.fetchTableData(
      request({ sorts: [{ column: 'customer_id', direction: 'desc' }] })
    )
    expect(response.rows[0][0]).toBe(4)

    const multi = await client.fetchTableData(
      request({
        schema: 'sales',
        table: 'order_items',
        sorts: [
          { column: 'order_id', direction: 'desc' },
          { column: 'line_no', direction: 'asc' }
        ]
      })
    )
    const ids = multi.rows.map((row) => [row[0], row[1]])
    expect(ids).toEqual([
      [105, 1],
      [100, 1],
      [100, 2]
    ])
  })

  it('works with no sort at all', async () => {
    const response = await client.fetchTableData(request({ sorts: [] }))
    expect(response.rows).toHaveLength(4)
    expect(response.sql).toContain('ORDER BY (SELECT NULL)')
  })

  describe('filters', () => {
    it('matches with equality', async () => {
      const response = await client.fetchTableData(
        request({ filters: [{ column: 'email', operator: '=', value: 'ada@example.com' }] })
      )
      expect(response.rows).toHaveLength(1)
      expect(response.totalRows).toBe(1)
    })

    it('matches with comparison operators', async () => {
      const response = await client.fetchTableData(
        request({ filters: [{ column: 'credit_limit', operator: '>', value: '100' }] })
      )
      expect(response.rows).toHaveLength(2)
    })

    it('matches with contains / starts with / ends with', async () => {
      const contains = await client.fetchTableData(
        request({ filters: [{ column: 'email', operator: 'contains', value: 'example' }] })
      )
      expect(contains.rows).toHaveLength(4)

      const starts = await client.fetchTableData(
        request({ filters: [{ column: 'email', operator: 'starts with', value: 'a' }] })
      )
      expect(starts.rows).toHaveLength(2)

      const ends = await client.fetchTableData(
        request({ filters: [{ column: 'display_name', operator: 'ends with', value: 'Hopper' }] })
      )
      expect(ends.rows).toHaveLength(1)
    })

    it('treats wildcards in a "contains" filter as literal text', async () => {
      // Without escaping, `%` would match every row.
      const response = await client.fetchTableData(
        request({ filters: [{ column: 'email', operator: 'contains', value: '%' }] })
      )
      expect(response.rows).toHaveLength(0)
    })

    it('matches with IN and NOT IN', async () => {
      const inList = await client.fetchTableData(
        request({
          filters: [{ column: 'email', operator: 'in', value: "'ada@example.com', 'alan@example.com'" }]
        })
      )
      expect(inList.rows).toHaveLength(2)

      const notIn = await client.fetchTableData(
        request({ filters: [{ column: 'customer_id', operator: 'not in', value: '1,2' }] })
      )
      expect(notIn.rows).toHaveLength(2)
    })

    it('matches with BETWEEN', async () => {
      const response = await client.fetchTableData(
        request({ filters: [{ column: 'customer_id', operator: 'between', value: '2', value2: '3' }] })
      )
      expect(response.rows.map((row) => row[0])).toEqual([2, 3])
    })

    it('matches NULL and NOT NULL', async () => {
      const isNull = await client.fetchTableData(
        request({ filters: [{ column: 'notes', operator: 'is null' }] })
      )
      expect(isNull.rows).toHaveLength(1)

      const notNull = await client.fetchTableData(
        request({ filters: [{ column: 'notes', operator: 'is not null' }] })
      )
      expect(notNull.rows).toHaveLength(3)
    })

    it('combines filters with AND and OR', async () => {
      const and = await client.fetchTableData(
        request({
          filters: [
            { column: 'is_active', operator: '=', value: '1' },
            { column: 'credit_limit', operator: '>', value: '100', conjunction: 'AND' }
          ]
        })
      )
      expect(and.rows).toHaveLength(2)

      const or = await client.fetchTableData(
        request({
          filters: [
            { column: 'customer_id', operator: '=', value: '1' },
            { column: 'customer_id', operator: '=', value: '4', conjunction: 'OR' }
          ]
        })
      )
      expect(or.rows).toHaveLength(2)
    })

    it('does not let a filter value inject SQL', async () => {
      const response = await client.fetchTableData(
        request({
          filters: [{ column: 'email', operator: '=', value: "x' OR '1'='1" }]
        })
      )
      expect(response.rows).toHaveLength(0)
    })

    it('accepts a raw WHERE clause with or without the keyword', async () => {
      const withKeyword = await client.fetchTableData(
        request({ filterMode: 'raw', rawWhere: 'WHERE credit_limit = 0' })
      )
      expect(withKeyword.rows).toHaveLength(1)

      const without = await client.fetchTableData(
        request({ filterMode: 'raw', rawWhere: "display_name LIKE 'A%'" })
      )
      expect(without.rows).toHaveLength(2)
      expect(without.totalRows).toBe(2)
    })
  })

  it('browses a table whose schema and name need quoting', async () => {
    const response = await client.fetchTableData(
      request({
        schema: 'odd name',
        table: 'weird ] table',
        sorts: [{ column: 'id ] col', direction: 'asc' }]
      })
    )
    expect(response.rows).toHaveLength(1)
    expect(response.columns.map((c) => c.name)).toEqual(['id ] col', "value's"])
  })
})

describe('editing table data', () => {
  beforeEach(async () => {
    await client.runScript(`
      DELETE FROM dbo.customers WHERE email LIKE N'edit-%';
      DELETE FROM dbo.no_pk WHERE a >= 900;
    `)
  })

  it('inserts a row', async () => {
    const applied = await client.applyChanges({
      connectionId: 'test-connection',
      schema: 'dbo',
      table: 'customers',
      inserts: [
        {
          tempId: 'tmp-1',
          values: { email: 'edit-insert@example.com', display_name: 'Inserted', credit_limit: 10 }
        }
      ],
      updates: [],
      deletes: []
    })
    expect(applied.inserted).toBe(1)

    const response = await client.fetchTableData(
      request({ filters: [{ column: 'email', operator: '=', value: 'edit-insert@example.com' }] })
    )
    expect(response.rows).toHaveLength(1)
    const nameIndex = indexOf(response.columns, 'display_name')
    expect(response.rows[0][nameIndex]).toBe('Inserted')
  })

  it('updates a row by primary key', async () => {
    await client.applyChanges({
      connectionId: 'test-connection',
      schema: 'dbo',
      table: 'customers',
      inserts: [{ tempId: 'tmp-1', values: { email: 'edit-update@example.com', credit_limit: 1 } }],
      updates: [],
      deletes: []
    })

    const before = await client.fetchTableData(
      request({ filters: [{ column: 'email', operator: '=', value: 'edit-update@example.com' }] })
    )
    const id = before.rows[0][indexOf(before.columns, 'customer_id')]

    const applied = await client.applyChanges({
      connectionId: 'test-connection',
      schema: 'dbo',
      table: 'customers',
      inserts: [],
      updates: [{ key: { customer_id: id }, changes: { display_name: 'Renamed', credit_limit: 55.5 } }],
      deletes: []
    })
    expect(applied.updated).toBe(1)

    const after = await client.fetchTableData(
      request({ filters: [{ column: 'customer_id', operator: '=', value: String(id) }] })
    )
    expect(after.rows[0][indexOf(after.columns, 'display_name')]).toBe('Renamed')
    expect(after.rows[0][indexOf(after.columns, 'credit_limit')]).toBe(55.5)
  })

  it('writes NULL through an update', async () => {
    await client.applyChanges({
      connectionId: 'test-connection',
      schema: 'dbo',
      table: 'customers',
      inserts: [
        { tempId: 't', values: { email: 'edit-null@example.com', display_name: 'not null yet' } }
      ],
      updates: [],
      deletes: []
    })
    const before = await client.fetchTableData(
      request({ filters: [{ column: 'email', operator: '=', value: 'edit-null@example.com' }] })
    )
    const id = before.rows[0][indexOf(before.columns, 'customer_id')]

    await client.applyChanges({
      connectionId: 'test-connection',
      schema: 'dbo',
      table: 'customers',
      inserts: [],
      updates: [{ key: { customer_id: id }, changes: { display_name: null } }],
      deletes: []
    })

    const after = await client.fetchTableData(
      request({ filters: [{ column: 'customer_id', operator: '=', value: String(id) }] })
    )
    expect(after.rows[0][indexOf(after.columns, 'display_name')]).toBeNull()
  })

  it('deletes a row', async () => {
    await client.applyChanges({
      connectionId: 'test-connection',
      schema: 'dbo',
      table: 'customers',
      inserts: [{ tempId: 't', values: { email: 'edit-delete@example.com' } }],
      updates: [],
      deletes: []
    })
    const before = await client.fetchTableData(
      request({ filters: [{ column: 'email', operator: '=', value: 'edit-delete@example.com' }] })
    )
    const id = before.rows[0][indexOf(before.columns, 'customer_id')]

    const applied = await client.applyChanges({
      connectionId: 'test-connection',
      schema: 'dbo',
      table: 'customers',
      inserts: [],
      updates: [],
      deletes: [{ key: { customer_id: id } }]
    })
    expect(applied.deleted).toBe(1)

    const after = await client.fetchTableData(
      request({ filters: [{ column: 'customer_id', operator: '=', value: String(id) }] })
    )
    expect(after.rows).toHaveLength(0)
  })

  it('rolls the whole change set back when one statement fails', async () => {
    await expect(
      client.applyChanges({
        connectionId: 'test-connection',
        schema: 'dbo',
        table: 'customers',
        inserts: [
          { tempId: 'a', values: { email: 'edit-ok@example.com' } },
          // Duplicate of an existing email — violates UQ_customers_email.
          { tempId: 'b', values: { email: 'ada@example.com' } }
        ],
        updates: [],
        deletes: []
      })
    ).rejects.toThrow(/duplicate key|UNIQUE/i)

    const response = await client.fetchTableData(
      request({ filters: [{ column: 'email', operator: '=', value: 'edit-ok@example.com' }] })
    )
    expect(response.rows).toHaveLength(0)
  })

  it('edits a keyless table using every column as the key', async () => {
    await client.runScript("INSERT INTO dbo.no_pk (a, b) VALUES (900, N'nine hundred')")

    const applied = await client.applyChanges({
      connectionId: 'test-connection',
      schema: 'dbo',
      table: 'no_pk',
      inserts: [],
      updates: [{ key: { a: 900, b: 'nine hundred' }, changes: { b: 'updated' } }],
      deletes: []
    })
    expect(applied.updated).toBe(1)
  })

  it('refuses to build a statement with no key columns', async () => {
    await expect(
      client.applyChanges({
        connectionId: 'test-connection',
        schema: 'dbo',
        table: 'customers',
        inserts: [],
        updates: [],
        deletes: [{ key: {} }]
      })
    ).rejects.toThrow(/no key columns/i)
  })

  it('round-trips binary and date values through an edit', async () => {
    await client.runScript('DELETE FROM dbo.wide_types WHERE c_varchar = \'roundtrip\'')
    await client.applyChanges({
      connectionId: 'test-connection',
      schema: 'dbo',
      table: 'wide_types',
      inserts: [
        {
          tempId: 't',
          values: {
            c_varchar: 'roundtrip',
            c_varbinary: { t: 'bytes', v: 'cafebabe', n: 4 },
            c_datetime2: { t: 'date', v: '2024-07-04T10:20:30.000Z' },
            c_bigint: { t: 'bigint', v: '9007199254740995' }
          }
        }
      ],
      updates: [],
      deletes: []
    })

    const response = await client.fetchTableData(
      request({
        schema: 'dbo',
        table: 'wide_types',
        sorts: [{ column: 'id', direction: 'asc' }],
        filters: [{ column: 'c_varchar', operator: '=', value: 'roundtrip' }]
      })
    )
    expect(response.rows).toHaveLength(1)
    const row = response.rows[0]
    expect(row[indexOf(response.columns, 'c_varbinary')]).toEqual({
      t: 'bytes',
      v: 'cafebabe',
      n: 4
    })
    expect(row[indexOf(response.columns, 'c_datetime2')]).toEqual({
      t: 'date',
      v: '2024-07-04T10:20:30.000Z'
    })
    expect(row[indexOf(response.columns, 'c_bigint')]).toBe('9007199254740995')
  })
})
