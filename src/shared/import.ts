/**
 * Rows from a file — or a range pasted from a spreadsheet — turned into rows a
 * table will take: which file column fills which table column, each value
 * read as that column's type, and every problem found before anything is sent.
 *
 * Nothing here talks to the server. The rows it gives back are staged as
 * inserts in the table's grid, the same as rows added by hand, and go up in
 * Apply's one transaction.
 */
import type { CellValue, TableColumn } from './types'

/** What an empty cell means for a column that takes text. */
export type EmptyAs = 'null' | 'empty'

export interface ImportProblem {
  /** Record number in the file, 1-based, counting a header row if there is one. */
  line: number
  column?: string
  message: string
}

export interface ImportRow {
  line: number
  /** By column name. A column left out takes its default. */
  values: Record<string, CellValue>
}

export interface ImportPlan {
  rows: ImportRow[]
  problems: ImportProblem[]
  /** Records with at least one problem; they are not among `rows`. */
  rejected: number
}

/** Table column name to the index of the file column that fills it, or null for none. */
export type ColumnMapping = Record<string, number | null>

/** Columns an insert may name: not identity, not computed, not a rowversion. */
export function importableColumns(columns: TableColumn[]): TableColumn[] {
  return columns.filter(
    (column) =>
      !column.isIdentity &&
      !column.isComputed &&
      !['timestamp', 'rowversion'].includes(column.dataType.toLowerCase())
  )
}

/** A name as headers are matched: no case, and no spaces, underscores, dashes or brackets. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s_\-[\]"`]/g, '')
}

/** File columns matched to table columns by name, to start with. */
export function matchColumns(header: string[], columns: TableColumn[]): ColumnMapping {
  const byName = new Map<string, number>()
  header.forEach((name, index) => {
    const key = normalizeName(name)
    if (key && !byName.has(key)) byName.set(key, index)
  })
  return Object.fromEntries(
    columns.map((column) => [column.name, byName.get(normalizeName(column.name)) ?? null])
  )
}

/** File columns taken in order, for a file with no header. */
export function positionalMapping(width: number, columns: TableColumn[]): ColumnMapping {
  return Object.fromEntries(
    columns.map((column, index) => [column.name, index < width ? index : null])
  )
}

const INTEGER_RANGES: Record<string, [bigint, bigint]> = {
  tinyint: [0n, 255n],
  smallint: [-32768n, 32767n],
  int: [-2147483648n, 2147483647n],
  bigint: [-9223372036854775808n, 9223372036854775807n]
}
const DECIMAL_TYPES = new Set(['decimal', 'numeric', 'money', 'smallmoney'])
const FLOAT_TYPES = new Set(['float', 'real'])
const DATE_TYPES = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'])
const TEXT_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'sysname', 'xml'])
const BINARY_TYPES = new Set(['binary', 'varbinary', 'image'])
const TRUE = new Set(['1', 'true', 'yes', 'y', 't'])
const FALSE = new Set(['0', 'false', 'no', 'n', 'f'])
const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i

/** How many characters a text column holds; null for `max` and the unbounded types. */
function textCapacity(column: TableColumn): number | null {
  const type = column.dataType.toLowerCase()
  if (column.maxLength === null || column.maxLength === -1) return null
  if (type === 'nchar' || type === 'nvarchar') return Math.trunc(column.maxLength / 2)
  if (type === 'char' || type === 'varchar') return column.maxLength
  return null
}

export type Converted = { value: CellValue } | { omit: true } | { problem: string }

/**
 * One cell's text as a value for `column`.
 *
 * Numbers that would lose digits as JS numbers — decimals, money, and integers
 * past 2^53 — stay as their text, which the server converts exactly. Dates stay
 * as text too, so a date is never moved by a time zone on its way: SQL Server
 * reads them as it would in a script.
 */
export function convertCell(text: string, column: TableColumn, emptyAs: EmptyAs): Converted {
  const type = column.dataType.toLowerCase()
  const isText = TEXT_TYPES.has(type)
  const raw = isText ? text : text.trim()

  if (raw === '' && !(isText && emptyAs === 'empty')) {
    if (column.nullable) return { value: null }
    // An explicit NULL would not take the default; leaving the column out does.
    if (column.defaultValue) return { omit: true }
    return { problem: 'is empty, and the column does not take NULL' }
  }

  const range = INTEGER_RANGES[type]
  if (range) {
    if (!/^[+-]?\d+$/.test(raw)) return { problem: `“${raw}” is not a whole number` }
    const big = BigInt(raw)
    if (big < range[0] || big > range[1]) return { problem: `${raw} is out of range for ${type}` }
    const number = Number(big)
    return { value: Number.isSafeInteger(number) ? number : big.toString() }
  }
  if (DECIMAL_TYPES.has(type)) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) return { problem: `“${raw}” is not a number` }
    if (column.precision !== null && column.scale !== null && (type === 'decimal' || type === 'numeric')) {
      const whole = raw.replace(/^[+-]/, '').split('.')[0].replace(/^0+/, '')
      if (whole.length > column.precision - column.scale) {
        return { problem: `${raw} is too large for ${column.fullType}` }
      }
    }
    return { value: raw }
  }
  if (FLOAT_TYPES.has(type)) {
    const number = Number(raw)
    if (raw === '' || !Number.isFinite(number)) return { problem: `“${raw}” is not a number` }
    return { value: number }
  }
  if (type === 'bit') {
    const lowered = raw.toLowerCase()
    if (TRUE.has(lowered)) return { value: true }
    if (FALSE.has(lowered)) return { value: false }
    return { problem: `“${raw}” is not true or false` }
  }
  if (DATE_TYPES.has(type)) {
    if (Number.isNaN(Date.parse(raw))) return { problem: `“${raw}” is not a date` }
    return { value: raw }
  }
  if (type === 'time') {
    if (!/^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(\s*[ap]m)?$/i.test(raw)) {
      return { problem: `“${raw}” is not a time of day` }
    }
    return { value: raw }
  }
  if (type === 'uniqueidentifier') {
    if (!GUID.test(raw)) return { problem: `“${raw}” is not a uniqueidentifier` }
    return { value: raw.replace(/^\{|\}$/g, '') }
  }
  if (BINARY_TYPES.has(type)) {
    if (!/^0x([0-9a-f]{2})*$/i.test(raw)) return { problem: `“${raw}” is not binary written as 0x…` }
    const hex = raw.slice(2).toLowerCase()
    return { value: { t: 'bytes', v: hex, n: hex.length / 2 } }
  }
  if (isText) {
    const capacity = textCapacity(column)
    const length = [...raw].length
    if (capacity !== null && length > capacity) {
      return { problem: `is ${length} characters, and the column holds ${capacity}` }
    }
  }
  return { value: raw }
}

/**
 * Columns that need a value and that no file column fills: NOT NULL, with no
 * default. Every row would be refused for the same reason, so it is said once,
 * about the mapping, rather than once per row.
 */
export function unfilledRequired(columns: TableColumn[], mapping: ColumnMapping): string[] {
  return columns
    .filter((column) => mapping[column.name] == null && !column.nullable && !column.defaultValue)
    .map((column) => column.name)
}

/**
 * Every record in the file as a row for the table, or the problems that keep
 * it out. `header` says the first record names the columns rather than
 * holding values.
 */
export function planImport(
  records: string[][],
  options: {
    header: boolean
    mapping: ColumnMapping
    columns: TableColumn[]
    emptyAs: EmptyAs
  }
): ImportPlan {
  const mapped = options.columns.filter((column) => options.mapping[column.name] != null)
  const rows: ImportRow[] = []
  const problems: ImportProblem[] = []
  let rejected = 0
  const first = options.header ? 1 : 0

  for (let index = first; index < records.length; index += 1) {
    const record = records[index]
    const line = index + 1
    const values: Record<string, CellValue> = {}
    let bad = false
    for (const column of mapped) {
      const text = record[options.mapping[column.name]!] ?? ''
      const converted = convertCell(text, column, options.emptyAs)
      if ('problem' in converted) {
        problems.push({ line, column: column.name, message: converted.problem })
        bad = true
      } else if ('value' in converted) {
        values[column.name] = converted.value
      }
    }
    if (bad) rejected += 1
    else rows.push({ line, values })
  }
  return { rows, problems, rejected }
}
