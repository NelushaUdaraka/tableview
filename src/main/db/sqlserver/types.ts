/** Mapping between driver type metadata and the app's column descriptors. */
import type { JsKind } from '../../../shared/types'

/** mssql reports `varchar(max)` and friends with this sentinel length. */
export const MAX_LENGTH_SENTINEL = 65535

const VARIABLE_LENGTH = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary'])
const WIDE_TYPES = new Set(['nchar', 'nvarchar'])

const STRING_TYPES = new Set([
  'char',
  'varchar',
  'nchar',
  'nvarchar',
  'text',
  'ntext',
  'xml',
  'uniqueidentifier'
])
const NUMBER_TYPES = new Set([
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'decimal',
  'numeric',
  'float',
  'real',
  'money',
  'smallmoney'
])
const DATE_TYPES = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'time'])
const BYTE_TYPES = new Set(['binary', 'varbinary', 'image', 'udt', 'geography', 'geometry'])

export interface DriverColumn {
  index: number
  name: string
  length?: number
  scale?: number
  precision?: number
  nullable?: boolean
  identity?: boolean
  readOnly?: boolean
  type?: { declaration?: string } | unknown
  udt?: { name?: string }
}

export function declarationOf(column: DriverColumn): string {
  const type = column.type as { declaration?: string } | undefined
  const declared = type?.declaration
  if (declared) return declared.toLowerCase()
  if (column.udt?.name) return column.udt.name.toLowerCase()
  return 'unknown'
}

/** Renders `nvarchar(50)`, `decimal(18, 2)`, `varbinary(max)` … */
export function renderDriverType(column: DriverColumn): string {
  const declaration = declarationOf(column)

  if (VARIABLE_LENGTH.has(declaration)) {
    const length = column.length
    if (length === undefined || length === null) return declaration
    if (length >= MAX_LENGTH_SENTINEL) return `${declaration}(max)`
    const divisor = WIDE_TYPES.has(declaration) ? 2 : 1
    return `${declaration}(${Math.max(1, Math.trunc(length / divisor))})`
  }

  if (declaration === 'decimal' || declaration === 'numeric') {
    return `${declaration}(${column.precision ?? 18}, ${column.scale ?? 0})`
  }

  if (['datetime2', 'datetimeoffset', 'time'].includes(declaration)) {
    return column.scale === undefined || column.scale === null
      ? declaration
      : `${declaration}(${column.scale})`
  }

  return declaration
}

export function jsKindOf(declaration: string): JsKind {
  const type = declaration.toLowerCase()
  if (STRING_TYPES.has(type)) return 'string'
  if (NUMBER_TYPES.has(type)) return 'number'
  if (DATE_TYPES.has(type)) return 'date'
  if (BYTE_TYPES.has(type)) return 'bytes'
  if (type === 'bit') return 'boolean'
  if (type === 'variant' || type === 'sql_variant') return 'json'
  return 'unknown'
}

/** Types that cannot be written back through a normal UPDATE. */
export function isReadOnlyType(declaration: string): boolean {
  return ['timestamp', 'rowversion'].includes(declaration.toLowerCase())
}
