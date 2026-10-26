import { describe, expect, it } from 'vitest'
import {
  changeSetScript,
  changeSetStatements,
  inlineParams
} from '../../src/shared/sql/changeScript'
import type { TableChangeSet } from '../../src/shared/types'

function changeSet(overrides: Partial<TableChangeSet> = {}): TableChangeSet {
  return {
    connectionId: 'c1',
    schema: 'sales',
    table: 'orders',
    inserts: [],
    updates: [],
    deletes: [],
    ...overrides
  }
}

describe('inlineParams', () => {
  it('writes each parameter in as a literal', () => {
    expect(
      inlineParams({
        sql: 'UPDATE [t] SET [a] = @p0, [b] = @p1 WHERE [id] = @p2',
        params: [
          { name: 'p0', value: "it's" },
          { name: 'p1', value: null },
          { name: 'p2', value: 7 }
        ]
      })
    ).toBe("UPDATE [t] SET [a] = N'it''s', [b] = NULL WHERE [id] = 7")
  })

  it('tells @p1 from @p10', () => {
    const params = Array.from({ length: 11 }, (_, index) => ({ name: `p${index}`, value: index }))
    expect(inlineParams({ sql: '@p1 @p10', params })).toBe('1 10')
  })

  it('leaves a name that only looks like a parameter alone', () => {
    expect(
      inlineParams({
        sql: 'UPDATE [t@p0] SET [x ]]@p0] = @p0',
        params: [{ name: 'p0', value: 1 }]
      })
    ).toBe('UPDATE [t@p0] SET [x ]]@p0] = 1')
  })

  it('writes tagged values the way an INSERT export does', () => {
    expect(
      inlineParams({
        sql: 'INSERT INTO [t] ([d], [b], [n]) VALUES (@p0, @p1, @p2)',
        params: [
          { name: 'p0', value: { t: 'date', v: '2024-03-01T10:00:00.000Z' } },
          { name: 'p1', value: { t: 'bytes', v: 'ff00', n: 2 } },
          { name: 'p2', value: { t: 'bigint', v: '9007199254740993' } }
        ]
      })
    ).toBe("INSERT INTO [t] ([d], [b], [n]) VALUES ('2024-03-01T10:00:00.000', 0xff00, 9007199254740993)")
  })
})

describe('changeSetStatements', () => {
  it('lists what Apply sends, in the order it sends it, values written in', () => {
    expect(
      changeSetStatements(
        changeSet({
          inserts: [{ tempId: 'new-0', values: { status: 'new' } }],
          updates: [{ key: { id: 2 }, changes: { status: 'shipped' } }],
          deletes: [{ key: { id: 1 } }]
        })
      )
    ).toEqual([
      'DELETE FROM [sales].[orders] WHERE [id] = 1;',
      "UPDATE [sales].[orders] SET [status] = N'shipped' WHERE [id] = 2;",
      "INSERT INTO [sales].[orders] ([status]) VALUES (N'new');"
    ])
  })

  it('matches a keyless row on every column, a NULL with IS NULL', () => {
    expect(
      changeSetStatements(changeSet({ deletes: [{ key: { a: 1, b: null, c: 'x' } }] }))
    ).toEqual(["DELETE FROM [sales].[orders] WHERE [a] = 1 AND [b] IS NULL AND [c] = N'x';"])
  })
})

describe('changeSetScript', () => {
  it('wraps the statements in one transaction that stops at the first error', () => {
    expect(
      changeSetScript(
        changeSet({
          updates: [
            { key: { id: 2 }, changes: { status: 'shipped' } },
            { key: { id: 3 }, changes: { status: 'shipped' } }
          ],
          deletes: [{ key: { id: 1 } }]
        })
      )
    ).toBe(
      [
        '-- Staged edits to sales.orders: 1 delete, 2 updates',
        'SET XACT_ABORT ON;',
        'BEGIN TRANSACTION;',
        '',
        'DELETE FROM [sales].[orders] WHERE [id] = 1;',
        "UPDATE [sales].[orders] SET [status] = N'shipped' WHERE [id] = 2;",
        "UPDATE [sales].[orders] SET [status] = N'shipped' WHERE [id] = 3;",
        '',
        'COMMIT TRANSACTION;',
        ''
      ].join('\n')
    )
  })
})
