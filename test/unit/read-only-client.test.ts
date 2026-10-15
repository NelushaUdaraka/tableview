/**
 * A read-only connection refuses a change before anything reaches the server.
 *
 * None of these clients is connected, which is the point: a refusal that needed
 * the pool would come back as "not connected" instead, and one that came after
 * the pool would already have sent the statement.
 */
import { describe, expect, it } from 'vitest'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'
import {
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  READ_ONLY_CONNECTION,
  type ConnectionConfig,
  type TableChangeSet,
  type TableDataRequest
} from '../../src/shared/types'

function client(readOnly: boolean): SqlServerClient {
  const config: ConnectionConfig = {
    id: 'c1',
    name: 'Prod',
    engine: 'sqlserver',
    host: 'db.internal',
    port: 1433,
    authType: 'sql',
    username: 'sa',
    password: 'x',
    savePassword: false,
    readOnly,
    options: { ...DEFAULT_SQLSERVER_OPTIONS },
    ssh: { ...DEFAULT_SSH_CONFIG },
    ssm: { ...DEFAULT_SSM_CONFIG },
    createdAt: '',
    updatedAt: ''
  }
  return new SqlServerClient(config)
}

const changeSet: TableChangeSet = {
  connectionId: 'c1',
  schema: 'dbo',
  table: 'orders',
  inserts: [],
  updates: [{ key: { id: 1 }, changes: { status: 'void' } }],
  deletes: []
}

function rawFilter(rawWhere: string): TableDataRequest {
  return {
    connectionId: 'c1',
    schema: 'dbo',
    table: 'orders',
    offset: 0,
    limit: 100,
    sorts: [],
    filters: [],
    filterMode: 'raw',
    rawWhere
  }
}

describe('a read-only connection', () => {
  it('answers a script that writes with a refusal, and runs none of it', async () => {
    const results = await client(true).runScript("PRINT 'first'\nGO\nSELECT 1\nDELETE FROM dbo.orders")

    expect(results).toHaveLength(1)
    expect(results[0].resultSets).toEqual([])
    expect(results[0].messages.filter((message) => message.kind === 'info')).toEqual([])
    expect(results[0].error).toMatchObject({ code: READ_ONLY_CONNECTION, lineNumber: 4 })
    expect(results[0].error?.message).toMatch(/^DELETE changes data/)
  })

  it('refuses to apply staged edits', async () => {
    await expect(client(true).applyChanges(changeSet)).rejects.toMatchObject({
      code: READ_ONLY_CONNECTION
    })
  })

  it('refuses to truncate or drop', async () => {
    await expect(client(true).truncateTable('dbo', 'orders')).rejects.toMatchObject({
      code: READ_ONLY_CONNECTION
    })
    await expect(client(true).dropObject('dbo', 'orders', 'table')).rejects.toMatchObject({
      code: READ_ONLY_CONNECTION
    })
  })

  it('refuses a raw filter with a write smuggled into it', async () => {
    await expect(
      client(true).fetchTableData(rawFilter("1 = 1; DELETE FROM dbo.orders WHERE status = 'x'"))
    ).rejects.toMatchObject({ code: READ_ONLY_CONNECTION })
  })

  it('still sends a read on to the server', async () => {
    // Unconnected, a read gets as far as wanting the pool.
    await expect(client(true).runScript('SELECT * FROM dbo.orders')).rejects.toThrow(/Not connected/)
    await expect(client(true).fetchTableData(rawFilter("status = 'new'"))).rejects.toThrow(
      /Not connected/
    )
  })
})

describe('a writable connection', () => {
  it('sends a write on to the server', async () => {
    await expect(client(false).runScript('DELETE FROM dbo.orders')).rejects.toThrow(/Not connected/)
    await expect(client(false).applyChanges(changeSet)).rejects.toThrow(/Not connected/)
  })
})
