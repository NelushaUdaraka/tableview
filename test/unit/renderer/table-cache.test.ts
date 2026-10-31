/**
 * What counts as a table's page having changed, and when a tab picked again
 * reads its page at all.
 *
 * A tab picked again draws the page it had; one that refreshes itself then
 * re-reads it behind the rows, as its timer does every few seconds.
 * Handing the grid the answer unconditionally would undo the point of that:
 * a new `columns` array resets the grid's widths and its selection, and a new
 * `rows` array loses the scroll position — so a re-read that came back with
 * the same page has to be recognised as the same page and dropped.
 *
 * Being wrong in the lenient direction is the expensive one: a cell reported
 * unchanged when it is not leaves a stale value on screen with nothing to say
 * so.
 */
import { describe, expect, it } from 'vitest'
import {
  readsOnReturn,
  sameCell,
  sameColumns,
  sameRow,
  sameRows
} from '../../../src/renderer/src/lib/tableCache'
import type { CellValue, ColumnMeta } from '../../../src/shared/types'

function column(name: string, index: number, over: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    index,
    dataType: 'int',
    jsKind: 'number',
    nullable: true,
    isIdentity: false,
    isReadOnly: false,
    ...over
  }
}

describe('sameCell', () => {
  it('compares plain values', () => {
    expect(sameCell(1, 1)).toBe(true)
    expect(sameCell('a', 'a')).toBe(true)
    expect(sameCell(null, null)).toBe(true)
    expect(sameCell(true, true)).toBe(true)

    expect(sameCell(1, 2)).toBe(false)
    expect(sameCell('1', 1)).toBe(false)
    expect(sameCell(null, 0)).toBe(false)
  })

  it('compares tagged values by what they carry, not by identity', () => {
    // They arrive rebuilt from IPC every time, so a fresh object holding the
    // same instant is the same cell.
    const at = (v: string): CellValue => ({ t: 'date', v })
    expect(sameCell(at('2024-01-01T00:00:00.000Z'), at('2024-01-01T00:00:00.000Z'))).toBe(true)
    expect(sameCell(at('2024-01-01T00:00:00.000Z'), at('2024-01-02T00:00:00.000Z'))).toBe(false)
  })

  it('tells a bigint from the string that spells it', () => {
    expect(sameCell({ t: 'bigint', v: '9007199254740993' }, '9007199254740993')).toBe(false)
    expect(sameCell({ t: 'bigint', v: '1' }, { t: 'json', v: '1' })).toBe(false)
  })

  it('counts binary by its length as well as its text', () => {
    // The text is a preview; two different blobs can share one.
    expect(sameCell({ t: 'bytes', v: '0xDEAD', n: 2 }, { t: 'bytes', v: '0xDEAD', n: 2 })).toBe(true)
    expect(sameCell({ t: 'bytes', v: '0xDEAD', n: 2 }, { t: 'bytes', v: '0xDEAD', n: 4096 })).toBe(
      false
    )
  })
})

describe('sameRow', () => {
  it('compares cell by cell', () => {
    expect(sameRow([1, 'a', null], [1, 'a', null])).toBe(true)
    expect(sameRow([1, 'a', null], [1, 'b', null])).toBe(false)
  })

  it('is false when one row is a different width, or missing', () => {
    expect(sameRow([1, 'a'], [1, 'a', null])).toBe(false)
    expect(sameRow(undefined, [1])).toBe(false)
    expect(sameRow([1], undefined)).toBe(false)
  })
})

describe('sameRows', () => {
  it('recognises a page that came back unchanged', () => {
    const before: CellValue[][] = [
      [1, 'Ada', { t: 'date', v: '2024-01-01T00:00:00.000Z' }],
      [2, 'Grace', null]
    ]
    const after: CellValue[][] = [
      [1, 'Ada', { t: 'date', v: '2024-01-01T00:00:00.000Z' }],
      [2, 'Grace', null]
    ]
    expect(sameRows(before, after)).toBe(true)
  })

  it('sees an edited cell, a new row and a deleted one', () => {
    const before: CellValue[][] = [[1, 'Ada'], [2, 'Grace']]
    expect(sameRows(before, [[1, 'Ada'], [2, 'Hopper']])).toBe(false)
    expect(sameRows(before, [[1, 'Ada'], [2, 'Grace'], [3, 'Alan']])).toBe(false)
    expect(sameRows(before, [[1, 'Ada']])).toBe(false)
  })

  it('sees two rows that swapped places', () => {
    // Which is a change: the page is what the grid draws, in the order it
    // draws it.
    expect(sameRows([[1], [2]], [[2], [1]])).toBe(false)
  })

  it('compares an empty page with itself', () => {
    expect(sameRows([], [])).toBe(true)
    expect(sameRows([], [[1]])).toBe(false)
  })
})

describe('sameColumns', () => {
  const before = [column('id', 0), column('name', 1, { dataType: 'nvarchar(50)', jsKind: 'string' })]

  it('recognises the same header', () => {
    expect(
      sameColumns(before, [
        column('id', 0),
        column('name', 1, { dataType: 'nvarchar(50)', jsKind: 'string' })
      ])
    ).toBe(true)
  })

  it('sees a renamed, retyped, added or dropped column', () => {
    expect(sameColumns(before, [column('id', 0), column('title', 1)])).toBe(false)
    expect(
      sameColumns(before, [column('id', 0), column('name', 1, { dataType: 'nvarchar(200)' })])
    ).toBe(false)
    expect(sameColumns(before, [column('id', 0)])).toBe(false)
    expect(sameColumns(before, [...before, column('added', 2)])).toBe(false)
  })

  it('sees a column that stopped being nullable, or became an identity', () => {
    // The grid draws both, and either means the table itself was altered.
    expect(sameColumns([column('id', 0)], [column('id', 0, { nullable: false })])).toBe(false)
    expect(sameColumns([column('id', 0)], [column('id', 0, { isIdentity: true })])).toBe(false)
    expect(sameColumns([column('id', 0)], [column('id', 0, { isReadOnly: true })])).toBe(false)
  })
})

/**
 * A tab picked again draws the page it kept; whether it then reads that page
 * again is this. The reader turned auto refresh off — or never turned it on —
 * so the page they left is the page they get back, and Refresh is there when
 * they want it read.
 */
describe('readsOnReturn', () => {
  it('leaves the page alone when the tab does not refresh itself', () => {
    expect(readsOnReturn({ database: 'sales' }, { autoRefresh: 0, database: 'sales' })).toBe(false)
  })

  it('reads a tab that refreshes itself, whose timer stopped while it was away', () => {
    expect(readsOnReturn({ database: 'sales' }, { autoRefresh: 5000, database: 'sales' })).toBe(true)
  })

  it('reads a page read in another database, which the next read would not show', () => {
    // The sidebar switched database while the tab was away: sorting or
    // paging would read the other database's table, so the page on screen
    // has to come from there too.
    expect(readsOnReturn({ database: 'sales' }, { autoRefresh: 0, database: 'archive' })).toBe(true)
  })
})
