/**
 * Whether a read of a table goes through a filter.
 *
 * The filter bar holds two kinds — the builder's rows and a raw `WHERE` — and
 * the main process uses one of them: the raw text when that is the mode and
 * there is something in it, and the builder's rows otherwise, even in raw mode
 * with the box left empty. This answers the same way, which is what lets
 * *Clear filters* know whether the rows on screen have anything to undo.
 */
import type { TableFilter } from '@shared/types'

export interface FilterState {
  filters: readonly TableFilter[]
  filterMode: 'builder' | 'raw'
  rawWhere: string
}

export function readsFiltered(state: FilterState): boolean {
  if (state.filterMode === 'raw' && state.rawWhere.trim() !== '') return true
  return state.filters.length > 0
}
