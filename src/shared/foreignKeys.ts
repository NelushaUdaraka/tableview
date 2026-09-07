/**
 * Following a foreign key from a row in the grid to the row it references.
 *
 * The grid knows a cell's value, not what it means; these helpers turn a
 * table's declared foreign keys into "which columns carry an arrow" and
 * "which filters open the referenced row".
 */
import { formatCellFull } from './serialize'
import type { CellValue, ColumnMeta, TableFilter, TableForeignKey } from './types'

/** What the arrow at the end of a cell points at. */
export interface ForeignKeyTarget {
  /** Constraint name, for the tooltip. */
  name: string
  schema: string
  table: string
  /** Columns in *this* table, in the constraint's order. */
  columns: string[]
  /** The columns they reference, positionally matched to `columns`. */
  referencedColumns: string[]
  /** `dbo.customers.customer_id`, for the tooltip. */
  label: string
}

/**
 * Maps each column that participates in a foreign key to its target, keyed by
 * the column's index in `columns` so the grid can look it up per cell.
 *
 * A composite key puts an arrow on every one of its columns: each of them
 * identifies the same referenced row, and the filters built below use all of
 * them whichever one was clicked.
 */
export function foreignKeyTargets(
  columns: ColumnMeta[],
  foreignKeys: TableForeignKey[]
): Record<number, ForeignKeyTarget> {
  const byName = new Map<string, number>()
  columns.forEach((column, index) => {
    // First occurrence wins; a duplicated name in a result set is not a key.
    if (!byName.has(column.name)) byName.set(column.name, index)
  })

  const targets: Record<number, ForeignKeyTarget> = {}
  for (const key of foreignKeys) {
    if (key.columns.length === 0 || key.columns.length !== key.referencedColumns.length) continue

    key.columns.forEach((columnName, position) => {
      const index = byName.get(columnName)
      if (index === undefined || index in targets) return
      targets[index] = {
        name: key.name,
        schema: key.referencedSchema,
        table: key.referencedTable,
        columns: key.columns,
        referencedColumns: key.referencedColumns,
        label: `${key.referencedSchema}.${key.referencedTable}.${key.referencedColumns[position]}`
      }
    })
  }
  return targets
}

/**
 * Renders a cell value as filter text.
 *
 * Filter values travel as strings and are bound as parameters, which SQL
 * Server converts to the referenced column's type. Two shapes have no
 * conversion that can be relied on — binary keys, and anything the driver
 * could not represent — so they return `null` and the arrow stays disabled
 * rather than opening a query that would silently match nothing.
 */
export function foreignKeyFilterValue(value: CellValue): string | null {
  if (value === null || value === undefined) return null

  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value

  switch (value.t) {
    case 'date':
      // `2024-05-01T09:30:00.000Z` is only convertible as a datetimeoffset;
      // the space-separated form converts to every other date type too.
      return value.v.replace('T', ' ').replace(/Z$/, '')
    case 'bigint':
      return value.v
    case 'json':
      return formatCellFull(value)
    case 'bytes':
      return null
  }
}

/**
 * The filters that select the referenced row, or `null` when the key cannot be
 * followed — a NULL column, or a value with no safe text form.
 */
export function foreignKeyFilters(
  target: ForeignKeyTarget,
  columns: ColumnMeta[],
  row: CellValue[]
): TableFilter[] | null {
  const filters: TableFilter[] = []

  for (let i = 0; i < target.columns.length; i += 1) {
    const index = columns.findIndex((column) => column.name === target.columns[i])
    if (index < 0) return null

    const value = foreignKeyFilterValue(row[index] ?? null)
    if (value === null) return null

    filters.push({
      column: target.referencedColumns[i],
      operator: '=',
      value,
      conjunction: 'AND'
    })
  }

  return filters.length > 0 ? filters : null
}

/** `customers.customer_id = 42`, for the tab's filter summary and tooltips. */
export function describeForeignKeyFilters(target: ForeignKeyTarget, filters: TableFilter[]): string {
  const pairs = filters.map((filter) => `${filter.column} = ${filter.value}`).join(' AND ')
  return `${target.schema}.${target.table} where ${pairs}`
}
