/**
 * The menu a column header raises.
 *
 * Both grids offer it — the table browser, where sorting and filtering mean a
 * new query and a column can be hidden, and the query results, where sorting
 * is a local reorder and there is nothing to filter. The entries that make no
 * sense in a given grid are left out rather than shown disabled, so what is
 * offered is what will work.
 */
import type { MenuEntry } from '../components/ContextMenu.vue'

export type ColumnMenuAction =
  | 'sort-asc'
  | 'sort-desc'
  | 'sort-add'
  | 'sort-clear'
  | 'filter-column'
  | 'filter-null'
  | 'filter-not-null'
  | 'filter-clear'
  | 'copy-name'
  | 'fit-column'
  | 'fit-all'
  | 'hide-column'
  | 'show-all-columns'

export interface ColumnMenuState {
  column: string
  /** How this column is sorted now, if it is. */
  direction: 'asc' | 'desc' | null
  /** Whether anything at all is sorted, which is what "clear" acts on. */
  anySort: boolean
  /**
   * Whether this grid can filter — the table browser can, because it rebuilds
   * the query; a result set on screen has nothing to re-ask.
   */
  filterable: boolean
  /** Whether a filter is set, so "clear" can say whether it would do anything. */
  filtered: boolean
  /**
   * Whether this grid can take columns out of view — the table browser can,
   * and keeps the choice on its tab; a result set shows what was selected.
   */
  hideable?: boolean
  /** Whether any column is hidden, so "show all" can say whether it would do anything. */
  anyHidden?: boolean
}

/**
 * The direction arrows read as they do in a spreadsheet rather than as SQL:
 * "A → Z" says what will happen to the values, where "ASC" says what the
 * clause will contain.
 */
export function columnMenuItems(state: ColumnMenuState): MenuEntry[] {
  const ascending = state.direction === 'asc'
  const descending = state.direction === 'desc'

  const items: MenuEntry[] = [
    { label: 'Sort A → Z', action: 'sort-asc', hint: ascending ? '✓' : undefined },
    { label: 'Sort Z → A', action: 'sort-desc', hint: descending ? '✓' : undefined },
    // Adding to the sort only means something once something else is sorted.
    ...(state.anySort && !state.direction
      ? [{ label: 'Add to sort', action: 'sort-add' } satisfies MenuEntry]
      : []),
    { label: 'Clear sorting', action: 'sort-clear', disabled: !state.anySort }
  ]

  if (state.filterable) {
    items.push(
      { separator: true, label: '' },
      { label: `Filter on ${state.column}…`, action: 'filter-column' },
      { label: 'Keep rows where this is NULL', action: 'filter-null' },
      { label: 'Keep rows where this is not NULL', action: 'filter-not-null' },
      { label: 'Clear filters', action: 'filter-clear', disabled: !state.filtered }
    )
  }

  items.push(
    { separator: true, label: '' },
    { label: 'Copy column name', action: 'copy-name' },
    { label: 'Fit this column', action: 'fit-column' },
    { label: 'Fit all columns', action: 'fit-all' }
  )

  if (state.hideable) {
    items.push(
      { separator: true, label: '' },
      { label: 'Hide this column', action: 'hide-column' },
      { label: 'Show all columns', action: 'show-all-columns', disabled: !state.anyHidden }
    )
  }

  return items
}
