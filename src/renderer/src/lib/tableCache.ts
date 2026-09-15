/**
 * The page a table tab last had on screen, and what counts as it having
 * changed.
 *
 * Only a pane's active tab is mounted, so picking another tab takes the table
 * browser down and everything it was holding with it — which is why coming
 * back to a tab used to mean an empty grid and a spinner for as long as the
 * server took. A tab keeps its last page here instead: the view draws it
 * before it has asked anything, then checks. The comparisons below are what
 * decide whether the answer, when it arrives, is worth redrawing for; rows
 * that came back the same are left exactly as they are, because replacing
 * them would cost the reader their scroll position, their selection and any
 * column they had widened by hand.
 */
import { isTagged, type CellValue, type ColumnMeta, type TableFilter, type TableSort } from '@shared/types'

export interface TableCache {
  columns: ColumnMeta[]
  rows: CellValue[][]
  totalRows: number | null
  /** The page these rows are, and the query that read them. */
  offset: number
  pageSize: number
  sorts: TableSort[]
  filters: TableFilter[]
  filterMode: 'builder' | 'raw'
  rawWhere: string
  showFilters: boolean
  durationMs: number
  sql: string
  /** Where the grid was scrolled to, in pixels. */
  scrollTop: number
  /**
   * The tab's `filterRevision` when these rows were read.
   *
   * Reopening a table reuses its tab, so a tab that was not mounted can be
   * asked for different rows while it is away — following a foreign key into
   * it, say. It comes back with a higher revision than the page was read at,
   * and that page is then an answer to a question nobody is asking any more.
   */
  filterRevision: number
}

/** Whether two cell values would draw the same. */
export function sameCell(a: CellValue, b: CellValue): boolean {
  if (a === b) return true
  if (!isTagged(a) || !isTagged(b)) return false
  if (a.t !== b.t || a.v !== b.v) return false
  // Binary carries its length beside the text that stands in for it.
  return a.t !== 'bytes' || (b.t === 'bytes' && a.n === b.n)
}

export function sameRow(a: CellValue[] | undefined, b: CellValue[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((value, index) => sameCell(value, b[index]))
}

export function sameRows(a: CellValue[][], b: CellValue[][]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((row, index) => sameRow(row, b[index]))
}

/**
 * Whether the grid would draw the same header.
 *
 * Deliberately not the whole of `ColumnMeta`: this asks whether the columns
 * the grid is drawing are still the right ones, and a column's ordinal or its
 * nullability changing under a page of rows means the table itself was
 * altered — which is the case the reload exists for.
 */
export function sameColumns(a: ColumnMeta[], b: ColumnMeta[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((column, index) => {
    const other = b[index]
    return (
      column.name === other.name &&
      column.dataType === other.dataType &&
      column.jsKind === other.jsKind &&
      column.nullable === other.nullable &&
      column.isIdentity === other.isIdentity &&
      column.isReadOnly === other.isReadOnly
    )
  })
}
