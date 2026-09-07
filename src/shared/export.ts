/**
 * Result-set exporters. Pure functions over the IPC cell representation so the
 * same code backs "copy to clipboard" in the renderer and "save to file" in main.
 */
import { CellValue, ColumnMeta, ExportOptions, isTagged } from './types'
import { formatCellFull } from './serialize'
import { quoteIdent, quoteString } from './sql/identifiers'

const DEFAULT_NULL = ''

function needsQuoting(value: string, delimiter: string): boolean {
  return (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  )
}

/** RFC 4180 field escaping. */
export function escapeDelimited(value: string, delimiter: string): string {
  if (!needsQuoting(value, delimiter)) return value
  return `"${value.replace(/"/g, '""')}"`
}

function cellToText(value: CellValue, nullString: string): string {
  if (value === null) return nullString
  return formatCellFull(value)
}

export function toDelimited(
  columns: ColumnMeta[],
  rows: CellValue[][],
  options: Partial<ExportOptions> = {}
): string {
  const delimiter = options.delimiter ?? (options.format === 'tsv' ? '\t' : ',')
  const eol = options.lineEnding ?? '\n'
  const nullString = options.nullString ?? DEFAULT_NULL
  const includeHeader = options.includeHeader ?? true

  const lines: string[] = []
  if (includeHeader) {
    lines.push(columns.map((column) => escapeDelimited(column.name, delimiter)).join(delimiter))
  }
  for (const row of rows) {
    lines.push(
      row.map((cell) => escapeDelimited(cellToText(cell, nullString), delimiter)).join(delimiter)
    )
  }
  return lines.join(eol) + (lines.length > 0 ? eol : '')
}

/** Converts a row to a plain object, de-duplicating repeated column names. */
export function rowToObject(columns: ColumnMeta[], row: CellValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const seen = new Map<string, number>()

  columns.forEach((column, index) => {
    let key = column.name || `column_${index + 1}`
    const count = seen.get(key) ?? 0
    seen.set(key, count + 1)
    if (count > 0) key = `${key}_${count + 1}`
    out[key] = jsonValue(row[index])
  })
  return out
}

function jsonValue(value: CellValue): unknown {
  if (value === null) return null
  if (isTagged(value)) {
    switch (value.t) {
      case 'date':
        return value.v
      case 'bytes':
        return `0x${value.v}`
      case 'bigint':
        return value.v
      case 'json':
        try {
          return JSON.parse(value.v)
        } catch {
          return value.v
        }
    }
  }
  return value
}

export function toJson(columns: ColumnMeta[], rows: CellValue[][], indent = 2): string {
  return JSON.stringify(
    rows.map((row) => rowToObject(columns, row)),
    null,
    indent
  )
}

export function toJsonLines(columns: ColumnMeta[], rows: CellValue[][]): string {
  return rows.map((row) => JSON.stringify(rowToObject(columns, row))).join('\n') + (rows.length ? '\n' : '')
}

const NUMERIC_TEXT = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/

/**
 * Renders a value as a T-SQL literal for INSERT export.
 *
 * `column` matters for wide integers: the driver hands back `bigint` as a
 * string to preserve precision, and quoting that would emit a string literal
 * for a numeric column.
 */
export function sqlLiteral(value: CellValue, column?: ColumnMeta): string {
  if (value === null) return 'NULL'

  if (typeof value === 'string' && column?.jsKind === 'number' && NUMERIC_TEXT.test(value)) {
    return value
  }

  if (isTagged(value)) {
    switch (value.t) {
      case 'date': {
        // SQL Server's datetime literals do not accept the trailing `Z`.
        const iso = value.v.endsWith('Z') ? value.v.slice(0, -1) : value.v
        return quoteString(iso, false)
      }
      case 'bytes':
        return value.v.length > 0 ? `0x${value.v}` : '0x'
      case 'bigint':
        return value.v
      case 'json':
        return quoteString(value.v)
    }
  }

  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return quoteString(String(value))
}

export function toSqlInserts(
  columns: ColumnMeta[],
  rows: CellValue[][],
  tableName = 'exported_table'
): string {
  if (rows.length === 0) return `-- no rows\n`

  const parts = tableName.includes('.') ? tableName.split('.') : [tableName]
  const target = parts.map((part) => quoteIdent(part.replace(/^\[|\]$/g, ''))).join('.')
  const columnList = columns.map((column) => quoteIdent(column.name)).join(', ')

  return (
    rows
      .map(
        (row) =>
          `INSERT INTO ${target} (${columnList}) VALUES (${row
            .map((cell, index) => sqlLiteral(cell, columns[index]))
            .join(', ')});`
      )
      .join('\n') + '\n'
  )
}

export function toMarkdown(columns: ColumnMeta[], rows: CellValue[][]): string {
  const escapeCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, '<br>')

  const header = `| ${columns.map((column) => escapeCell(column.name)).join(' | ')} |`
  const divider = `| ${columns.map(() => '---').join(' | ')} |`
  const body = rows.map(
    (row) => `| ${row.map((cell) => escapeCell(cellToText(cell, 'NULL'))).join(' | ')} |`
  )
  return [header, divider, ...body].join('\n') + '\n'
}

export function exportRows(
  columns: ColumnMeta[],
  rows: CellValue[][],
  options: ExportOptions
): string {
  switch (options.format) {
    case 'csv':
      return toDelimited(columns, rows, { ...options, delimiter: options.delimiter ?? ',' })
    case 'tsv':
      return toDelimited(columns, rows, { ...options, delimiter: options.delimiter ?? '\t' })
    case 'json':
      return toJson(columns, rows)
    case 'jsonl':
      return toJsonLines(columns, rows)
    case 'sql':
      return toSqlInserts(columns, rows, options.tableName)
    case 'markdown':
      return toMarkdown(columns, rows)
    default:
      throw new Error(`Unsupported export format: ${String(options.format)}`)
  }
}

export const EXPORT_EXTENSIONS: Record<ExportOptions['format'], string> = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  jsonl: 'jsonl',
  sql: 'sql',
  markdown: 'md'
}
