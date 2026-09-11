/**
 * Sorting a result set that is already on screen.
 *
 * The values are the tagged ones that crossed the IPC boundary, not the driver
 * types, so anything that compares them has to understand that shape — a date
 * arrives as `{ t: 'date', v: '2024-01-02T…' }` and would otherwise sort as the
 * text of an ISO string.
 */
import { describe, expect, it } from 'vitest'
import { sortRows } from '../../../src/renderer/src/lib/sortRows'
import type { CellValue } from '../../../src/shared/types'

const column = (rows: CellValue[][], index = 0): CellValue[] => rows.map((row) => row[index])

describe('sortRows', () => {
  it('orders numbers numerically rather than as text', () => {
    const rows: CellValue[][] = [[9], [10], [2]]
    expect(column(sortRows(rows, 0, 'asc'))).toEqual([2, 9, 10])
    expect(column(sortRows(rows, 0, 'desc'))).toEqual([10, 9, 2])
  })

  it('orders tagged dates by their instant', () => {
    const rows: CellValue[][] = [
      [{ t: 'date', v: '2024-03-01T00:00:00.000Z' }],
      [{ t: 'date', v: '2023-12-31T23:00:00.000Z' }]
    ]
    expect(column(sortRows(rows, 0, 'asc'))).toEqual([
      { t: 'date', v: '2023-12-31T23:00:00.000Z' },
      { t: 'date', v: '2024-03-01T00:00:00.000Z' }
    ])
  })

  it('sorts text naturally, so item2 comes before item10', () => {
    const rows: CellValue[][] = [['item10'], ['item2'], ['item1']]
    expect(column(sortRows(rows, 0, 'asc'))).toEqual(['item1', 'item2', 'item10'])
  })

  it('leaves NULLs at the end in both directions', () => {
    const rows: CellValue[][] = [[null], [3], [1]]
    expect(column(sortRows(rows, 0, 'asc'))).toEqual([1, 3, null])
    expect(column(sortRows(rows, 0, 'desc'))).toEqual([3, 1, null])
  })

  it('keeps equal rows in the order they arrived', () => {
    const rows: CellValue[][] = [
      [1, 'first'],
      [1, 'second'],
      [0, 'third']
    ]
    expect(sortRows(rows, 0, 'asc').map((row) => row[1])).toEqual(['third', 'first', 'second'])
  })

  it('does not disturb the rows it was given', () => {
    const rows: CellValue[][] = [[2], [1]]
    sortRows(rows, 0, 'asc')
    expect(column(rows)).toEqual([2, 1])
  })

  it('compares big integers past the safe range without collapsing them', () => {
    const rows: CellValue[][] = [
      [{ t: 'bigint', v: '9007199254740993' }],
      [{ t: 'bigint', v: '9007199254740992' }]
    ]
    expect(column(sortRows(rows, 0, 'asc'))).toEqual([
      { t: 'bigint', v: '9007199254740992' },
      { t: 'bigint', v: '9007199254740993' }
    ])
  })
})
