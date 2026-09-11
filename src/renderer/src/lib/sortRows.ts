/**
 * Sorting a result set that is already on screen.
 *
 * A query's rows cannot be re-fetched in a different order — the statement is
 * the user's, not ours to rewrite — so the grid reorders what it has. The table
 * browser does not use this: there, sorting is an ORDER BY and a new page.
 */
import type { CellValue } from '@shared/types'
import { isTagged } from '@shared/types'

export type SortDirection = 'asc' | 'desc'

/** A value reduced to something two of which can be compared. */
function sortable(value: CellValue): number | string | boolean | null {
  if (value === null || value === undefined) return null
  if (!isTagged(value)) return value

  switch (value.t) {
    case 'date': {
      const time = Date.parse(value.v)
      return Number.isNaN(time) ? value.v : time
    }
    case 'bigint': {
      const asNumber = Number(value.v)
      // Past 2^53 the numeric form stops being distinct; the decimal text of
      // two same-length integers sorts the same way the integers do.
      return Number.isSafeInteger(asNumber) ? asNumber : value.v.padStart(40, '0')
    }
    default:
      return value.v
  }
}

/** Ascending order, with NULLs after everything, whichever way it is read. */
function compare(a: CellValue, b: CellValue): number {
  const left = sortable(a)
  const right = sortable(b)

  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1

  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right)
  }
  // `numeric` makes item2 sort before item10, which is what a reader expects
  // of an identifier column that happens to be text.
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base'
  })
}

/**
 * A copy of `rows` ordered by one column.
 *
 * NULLs stay at the end in both directions — they are absent values rather
 * than small ones, and burying them under a descending sort hides rows the
 * reader was looking at a moment ago.
 */
export function sortRows(
  rows: CellValue[][],
  columnIndex: number,
  direction: SortDirection
): CellValue[][] {
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort((rowA, rowB) => {
    const a = rowA?.[columnIndex] ?? null
    const b = rowB?.[columnIndex] ?? null
    // NULLs are pinned last, so the flip applies to the values only.
    if (a === null && b === null) return 0
    if (a === null) return 1
    if (b === null) return -1
    return sign * compare(a, b)
  })
}
