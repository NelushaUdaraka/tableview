/**
 * Parameterised T-SQL builders for table browsing and editing.
 *
 * Every value supplied by the user is bound as a parameter; only identifiers
 * are interpolated, and those go through `quoteIdent`. The one deliberate
 * exception is the raw WHERE mode, where the user is explicitly writing SQL.
 */
import {
  CellValue,
  TableColumn,
  TableFilter,
  TableForeignKey,
  TableIndex,
  TableChangeSet,
  TableSort,
  TableStructure
} from '../types'
import { escapeLikePattern, qualify, quoteIdent, quoteString } from './identifiers'

export interface SqlParam {
  name: string
  value: CellValue
}

export interface BuiltQuery {
  sql: string
  params: SqlParam[]
}

/** Allocates unique parameter names as values are collected. */
export class ParamBag {
  private readonly items: SqlParam[] = []

  constructor(private readonly prefix = 'p') {}

  add(value: CellValue): string {
    const name = `${this.prefix}${this.items.length}`
    this.items.push({ name, value })
    return `@${name}`
  }

  all(): SqlParam[] {
    return [...this.items]
  }

  get size(): number {
    return this.items.length
  }
}

const NO_VALUE_OPERATORS = new Set(['is null', 'is not null'])

/** Splits a comma-separated IN list, honouring quoted segments. */
export function splitInList(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (quote) {
      if (ch === quote) {
        if (value[i + 1] === quote) {
          current += ch
          i += 1
          continue
        }
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === ',') {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current.trim())
  return parts.filter((part) => part.length > 0)
}

/** Renders one filter into a predicate, binding its values. */
export function buildFilterPredicate(filter: TableFilter, params: ParamBag): string {
  const column = quoteIdent(filter.column)
  const operator = filter.operator
  const value = filter.value ?? ''

  if (NO_VALUE_OPERATORS.has(operator)) {
    return operator === 'is null' ? `${column} IS NULL` : `${column} IS NOT NULL`
  }

  switch (operator) {
    case 'in':
    case 'not in': {
      const items = splitInList(value)
      if (items.length === 0) {
        // An empty IN list must not match everything.
        return operator === 'in' ? '1 = 0' : '1 = 1'
      }
      const placeholders = items.map((item) => params.add(item)).join(', ')
      return `${column} ${operator === 'in' ? 'IN' : 'NOT IN'} (${placeholders})`
    }
    case 'between': {
      const low = params.add(value)
      const high = params.add(filter.value2 ?? '')
      return `${column} BETWEEN ${low} AND ${high}`
    }
    case 'starts with':
      return `${column} LIKE ${params.add(`${escapeLikePattern(value)}%`)} ESCAPE '\\'`
    case 'ends with':
      return `${column} LIKE ${params.add(`%${escapeLikePattern(value)}`)} ESCAPE '\\'`
    case 'contains':
      return `${column} LIKE ${params.add(`%${escapeLikePattern(value)}%`)} ESCAPE '\\'`
    case 'like':
      return `${column} LIKE ${params.add(value)}`
    case 'not like':
      return `${column} NOT LIKE ${params.add(value)}`
    case '=':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return `${column} ${operator} ${params.add(value)}`
    default:
      throw new Error(`Unsupported filter operator: ${String(operator)}`)
  }
}

export interface WhereClause {
  sql: string
  params: SqlParam[]
}

/** Combines filters into a WHERE clause (empty string when there are none). */
export function buildWhereClause(filters: TableFilter[], params?: ParamBag): string {
  const bag = params ?? new ParamBag()
  if (!filters || filters.length === 0) return ''

  const parts: string[] = []
  filters.forEach((filter, index) => {
    const predicate = buildFilterPredicate(filter, bag)
    if (index === 0) {
      parts.push(predicate)
    } else {
      parts.push(`${filter.conjunction === 'OR' ? 'OR' : 'AND'} ${predicate}`)
    }
  })

  return `WHERE ${parts.join(' ')}`
}

export function buildOrderByClause(sorts: TableSort[]): string {
  if (!sorts || sorts.length === 0) {
    // OFFSET/FETCH requires an ORDER BY; this is the canonical no-op ordering.
    return 'ORDER BY (SELECT NULL)'
  }
  const parts = sorts.map(
    (sort) => `${quoteIdent(sort.column)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`
  )
  return `ORDER BY ${parts.join(', ')}`
}

export interface SelectOptions {
  schema: string
  table: string
  columns?: string[]
  filters?: TableFilter[]
  rawWhere?: string
  sorts?: TableSort[]
  offset?: number
  limit?: number
}

export function buildSelectQuery(options: SelectOptions): BuiltQuery {
  const params = new ParamBag()
  const target = qualify(options.schema, options.table)
  const columnList =
    options.columns && options.columns.length > 0
      ? options.columns.map(quoteIdent).join(', ')
      : '*'

  const where = options.rawWhere?.trim()
    ? `WHERE ${stripLeadingWhere(options.rawWhere)}`
    : buildWhereClause(options.filters ?? [], params)

  const orderBy = buildOrderByClause(options.sorts ?? [])

  const lines = [`SELECT ${columnList}`, `FROM ${target}`]
  if (where) lines.push(where)
  lines.push(orderBy)

  if (options.limit !== undefined) {
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = Math.max(0, Math.trunc(options.limit))
    lines.push(`OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`)
  }

  return { sql: lines.join('\n'), params: params.all() }
}

export function buildCountQuery(
  options: Pick<SelectOptions, 'schema' | 'table' | 'filters' | 'rawWhere'>
): BuiltQuery {
  const params = new ParamBag()
  const target = qualify(options.schema, options.table)
  const where = options.rawWhere?.trim()
    ? `WHERE ${stripLeadingWhere(options.rawWhere)}`
    : buildWhereClause(options.filters ?? [], params)

  const lines = [`SELECT COUNT_BIG(*) AS [total]`, `FROM ${target}`]
  if (where) lines.push(where)
  return { sql: lines.join('\n'), params: params.all() }
}

/** Lets users type either `x = 1` or `WHERE x = 1` in the raw filter box. */
export function stripLeadingWhere(raw: string): string {
  return raw.trim().replace(/^where\s+/i, '')
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Builds `WHERE` matching exactly one row from its key columns. */
function buildKeyPredicate(key: Record<string, CellValue>, params: ParamBag): string {
  const entries = Object.entries(key)
  if (entries.length === 0) {
    throw new Error(
      'Refusing to build a statement with no key columns — this would affect every row'
    )
  }
  return entries
    .map(([column, value]) =>
      value === null ? `${quoteIdent(column)} IS NULL` : `${quoteIdent(column)} = ${params.add(value)}`
    )
    .join(' AND ')
}

export function buildInsertStatement(
  schema: string,
  table: string,
  values: Record<string, CellValue>
): BuiltQuery {
  const params = new ParamBag()
  const entries = Object.entries(values)
  const target = qualify(schema, table)

  if (entries.length === 0) {
    return { sql: `INSERT INTO ${target} DEFAULT VALUES`, params: [] }
  }

  const columns = entries.map(([column]) => quoteIdent(column)).join(', ')
  const placeholders = entries.map(([, value]) => params.add(value)).join(', ')
  return {
    sql: `INSERT INTO ${target} (${columns}) VALUES (${placeholders})`,
    params: params.all()
  }
}

export function buildUpdateStatement(
  schema: string,
  table: string,
  key: Record<string, CellValue>,
  changes: Record<string, CellValue>
): BuiltQuery {
  const changeEntries = Object.entries(changes)
  if (changeEntries.length === 0) {
    throw new Error('Refusing to build an UPDATE with no changed columns')
  }

  const params = new ParamBag()
  const target = qualify(schema, table)
  const assignments = changeEntries
    .map(([column, value]) => `${quoteIdent(column)} = ${params.add(value)}`)
    .join(', ')
  const predicate = buildKeyPredicate(key, params)

  return {
    sql: `UPDATE ${target} SET ${assignments} WHERE ${predicate}`,
    params: params.all()
  }
}

export function buildDeleteStatement(
  schema: string,
  table: string,
  key: Record<string, CellValue>
): BuiltQuery {
  const params = new ParamBag()
  const target = qualify(schema, table)
  const predicate = buildKeyPredicate(key, params)
  return { sql: `DELETE FROM ${target} WHERE ${predicate}`, params: params.all() }
}

/**
 * Staged grid edits as the statements Apply sends, in the order it sends them:
 * deletes, then updates, then inserts. The main process runs these; the review
 * before Apply shows the same ones (`changeScript.ts`).
 */
export function buildChangeSetStatements(changeSet: TableChangeSet): BuiltQuery[] {
  const { schema, table } = changeSet
  return [
    ...changeSet.deletes.map((item) => buildDeleteStatement(schema, table, item.key)),
    ...changeSet.updates.map((item) => buildUpdateStatement(schema, table, item.key, item.changes)),
    ...changeSet.inserts.map((item) => buildInsertStatement(schema, table, item.values))
  ]
}

// ---------------------------------------------------------------------------
// DDL generation
// ---------------------------------------------------------------------------

/** Renders a column's type with length/precision, e.g. `decimal(18, 2)`. */
export function renderColumnType(column: Pick<TableColumn, 'dataType' | 'maxLength' | 'precision' | 'scale'>): string {
  const type = column.dataType.toLowerCase()

  if (['varchar', 'nvarchar', 'char', 'nchar', 'binary', 'varbinary'].includes(type)) {
    if (column.maxLength === null || column.maxLength === undefined) return type
    if (column.maxLength === -1) return `${type}(max)`
    // sys.columns reports nvarchar/nchar length in bytes.
    const divisor = type === 'nvarchar' || type === 'nchar' ? 2 : 1
    return `${type}(${Math.trunc(column.maxLength / divisor)})`
  }

  if (['decimal', 'numeric'].includes(type)) {
    return `${type}(${column.precision ?? 18}, ${column.scale ?? 0})`
  }

  if (['datetime2', 'datetimeoffset', 'time'].includes(type)) {
    return column.scale === null || column.scale === undefined ? type : `${type}(${column.scale})`
  }

  if (type === 'float') {
    return column.precision === null || column.precision === undefined || column.precision === 53
      ? type
      : `${type}(${column.precision})`
  }

  return type
}

/** Reconstructs a readable `CREATE TABLE` for a table structure. */
export function buildCreateTableDdl(structure: TableStructure): string {
  const target = qualify(structure.schema, structure.name)
  const lines: string[] = [`CREATE TABLE ${target} (`]

  const columnLines = structure.columns.map((column) => {
    if (column.isComputed) {
      return `  ${quoteIdent(column.name)} AS ${column.computedDefinition ?? 'NULL'}`
    }
    const pieces = [`  ${quoteIdent(column.name)}`, renderColumnType(column)]
    if (column.collation) pieces.push(`COLLATE ${column.collation}`)
    if (column.isIdentity) {
      pieces.push(`IDENTITY(${column.identitySeed ?? 1}, ${column.identityIncrement ?? 1})`)
    }
    pieces.push(column.nullable ? 'NULL' : 'NOT NULL')
    if (column.defaultValue) pieces.push(`DEFAULT ${column.defaultValue}`)
    return pieces.join(' ')
  })

  if (structure.primaryKey.length > 0) {
    const pkIndex = structure.indexes.find((index) => index.isPrimaryKey)
    const pkName = pkIndex?.name ?? `PK_${structure.name}`
    const pkColumns = structure.primaryKey.map(quoteIdent).join(', ')
    const clustering = pkIndex?.isClustered === false ? 'NONCLUSTERED ' : 'CLUSTERED '
    columnLines.push(`  CONSTRAINT ${quoteIdent(pkName)} PRIMARY KEY ${clustering}(${pkColumns})`)
  }

  // Unique constraints are declared inline; their backing index is then skipped
  // below so the table is not given the same key twice.
  const uniqueConstraints = structure.constraints.filter((c) => c.type === 'unique')
  for (const constraint of uniqueConstraints) {
    columnLines.push(`  CONSTRAINT ${quoteIdent(constraint.name)} UNIQUE (${constraint.definition
      .split(',')
      .map((part) => quoteIdent(part.trim()))
      .join(', ')})`)
  }

  for (const constraint of structure.constraints.filter((c) => c.type === 'check')) {
    columnLines.push(`  CONSTRAINT ${quoteIdent(constraint.name)} CHECK ${constraint.definition}`)
  }

  lines.push(columnLines.join(',\n'))
  lines.push(');')

  for (const fk of structure.foreignKeys) {
    lines.push('')
    lines.push(buildForeignKeyDdl(structure.schema, structure.name, fk))
  }

  const uniqueNames = new Set(uniqueConstraints.map((c) => c.name))
  for (const index of structure.indexes.filter(
    (i) => !i.isPrimaryKey && !uniqueNames.has(i.name)
  )) {
    lines.push('')
    lines.push(buildIndexDdl(structure.schema, structure.name, index))
  }

  return lines.join('\n')
}

export function buildForeignKeyDdl(schema: string, table: string, fk: TableForeignKey): string {
  const columns = fk.columns.map(quoteIdent).join(', ')
  const referenced = fk.referencedColumns.map(quoteIdent).join(', ')
  const clauses = [
    `ALTER TABLE ${qualify(schema, table)}`,
    `  ADD CONSTRAINT ${quoteIdent(fk.name)} FOREIGN KEY (${columns})`,
    `  REFERENCES ${qualify(fk.referencedSchema, fk.referencedTable)} (${referenced})`
  ]
  if (fk.onDelete && fk.onDelete !== 'NO_ACTION') {
    clauses.push(`  ON DELETE ${fk.onDelete.replace(/_/g, ' ')}`)
  }
  if (fk.onUpdate && fk.onUpdate !== 'NO_ACTION') {
    clauses.push(`  ON UPDATE ${fk.onUpdate.replace(/_/g, ' ')}`)
  }
  return `${clauses.join('\n')};`
}

export function buildIndexDdl(schema: string, table: string, index: TableIndex): string {
  const keyColumns = index.columns
    .filter((column) => !column.isIncluded)
    .map((column) => `${quoteIdent(column.name)}${column.descending ? ' DESC' : ''}`)
    .join(', ')
  const included = index.columns.filter((column) => column.isIncluded)

  let sql = `CREATE ${index.isUnique ? 'UNIQUE ' : ''}${index.isClustered ? 'CLUSTERED' : 'NONCLUSTERED'} INDEX ${quoteIdent(index.name)}\n  ON ${qualify(schema, table)} (${keyColumns})`
  if (included.length > 0) {
    sql += `\n  INCLUDE (${included.map((column) => quoteIdent(column.name)).join(', ')})`
  }
  if (index.filterDefinition) {
    sql += `\n  WHERE ${index.filterDefinition}`
  }
  return `${sql};`
}

// ---------------------------------------------------------------------------
// Statement templates offered from the sidebar context menu
// ---------------------------------------------------------------------------

export function buildSelectTemplate(structure: TableStructure, limit = 100): string {
  const columns = structure.columns
    .map((column) => `  ${quoteIdent(column.name)}`)
    .join(',\n')
  return `SELECT TOP (${limit})\n${columns}\nFROM ${qualify(structure.schema, structure.name)};`
}

export function buildInsertTemplate(structure: TableStructure): string {
  const writable = structure.columns.filter((column) => !column.isIdentity && !column.isComputed)
  const columns = writable.map((column) => quoteIdent(column.name)).join(', ')
  const values = writable
    .map((column) => (column.nullable ? 'NULL' : placeholderFor(column)))
    .join(', ')
  return `INSERT INTO ${qualify(structure.schema, structure.name)} (${columns})\nVALUES (${values});`
}

export function buildUpdateTemplate(structure: TableStructure): string {
  const writable = structure.columns.filter(
    (column) => !column.isIdentity && !column.isComputed && !structure.primaryKey.includes(column.name)
  )
  const assignments = writable
    .map((column) => `  ${quoteIdent(column.name)} = ${placeholderFor(column)}`)
    .join(',\n')
  const predicate = whereTemplate(structure)
  return `UPDATE ${qualify(structure.schema, structure.name)}\nSET\n${assignments}\nWHERE ${predicate};`
}

export function buildDeleteTemplate(structure: TableStructure): string {
  return `DELETE FROM ${qualify(structure.schema, structure.name)}\nWHERE ${whereTemplate(structure)};`
}

function whereTemplate(structure: TableStructure): string {
  const keys = structure.primaryKey.length > 0 ? structure.primaryKey : [structure.columns[0]?.name]
  return keys
    .filter(Boolean)
    .map((name) => {
      const column = structure.columns.find((c) => c.name === name)
      return `${quoteIdent(name)} = ${column ? placeholderFor(column) : '?'}`
    })
    .join(' AND ')
}

function placeholderFor(column: TableColumn): string {
  const type = column.dataType.toLowerCase()
  if (/int|decimal|numeric|float|real|money|bit/.test(type)) return '0'
  if (/date|time/.test(type)) return quoteString('1970-01-01')
  if (/binary/.test(type)) return '0x'
  if (/uniqueidentifier/.test(type)) return 'NEWID()'
  return quoteString('')
}
