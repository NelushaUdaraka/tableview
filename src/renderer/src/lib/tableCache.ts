/**
 * The page a table tab last had on screen, whether to read it again, and what
 * counts as it having changed.
 *
 * Only a pane's active tab is mounted, so picking another tab takes the table
 * browser down and everything it was holding with it — which is why coming
 * back to a tab used to mean an empty grid and a spinner for as long as the
 * server took. A tab keeps its last page here instead, scrolled where it was
 * and with its columns as wide as they were: the view draws it before it has
 * asked anything, and reads it again only when the tab refreshes itself
 * (`readsOnReturn`). The comparisons below are what decide whether the
 * answer to a read is worth redrawing for; rows that came back the same are
 * left exactly as they are, because replacing them would cost the reader
 * their scroll position, their selection and any column they had widened by
 * hand.
 */
import { isTagged, type CellValue, type ColumnMeta, type TableFilter, type TableSort } from '@shared/types'
import type { GridView } from '../components/DataGrid.vue'

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
  /** Where the grid was scrolled to, both ways, and how wide its columns were. */
  grid: GridView
  /**
   * The database the rows were read in: the sidebar can switch it while the
   * tab is away, and the tab's next read goes wherever the sidebar is.
   */
  database: string
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

/**
 * Whether a tab coming back on screen reads its page again, rather than
 * showing the one it kept as it is.
 *
 * Only a tab that refreshes itself does: its timer stopped with the view, and
 * catching up is what it would have been doing. Any other tab comes back
 * exactly as it was left — reading it again would move rows under the reader
 * that they did not ask to have moved, and Refresh is there when they do. The
 * one exception is a page read in a database the sidebar has since left,
 * which sorting or paging would no longer agree with.
 */
export function readsOnReturn(
  cache: Pick<TableCache, 'database'>,
  now: { autoRefresh: number; database: string }
): boolean {
  return now.autoRefresh > 0 || cache.database !== now.database
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
