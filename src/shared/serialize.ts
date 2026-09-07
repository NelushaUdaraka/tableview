/**
 * Conversion between driver values and the structured-clone-safe `CellValue`
 * representation that crosses the IPC boundary.
 *
 * Dates, Buffers and BigInts either do not survive the boundary intact or lose
 * their identity once there, so they are wrapped in a small tagged object that
 * round-trips back to the original type when a row is written back.
 */
import { CellValue, TaggedValue, isTagged } from './types'

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error('Hex string must have an even length')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(clean.substr(i * 2, 2), 16)
    if (Number.isNaN(byte)) throw new Error(`Invalid hex at offset ${i * 2}`)
    out[i] = byte
  }
  return out
}

/** Driver value -> IPC-safe value. */
export function serializeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null

  const type = typeof value
  if (type === 'string' || type === 'boolean') return value as string | boolean

  if (type === 'number') {
    // NaN/Infinity are not JSON-representable; keep them legible as text.
    if (!Number.isFinite(value as number)) return String(value)
    return value as number
  }

  if (type === 'bigint') return { t: 'bigint', v: (value as bigint).toString() }

  if (value instanceof Date) {
    const time = value.getTime()
    if (Number.isNaN(time)) return null
    return { t: 'date', v: value.toISOString() }
  }

  if (value instanceof Uint8Array) {
    return { t: 'bytes', v: bytesToHex(value), n: value.length }
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    return { t: 'bytes', v: bytesToHex(bytes), n: bytes.length }
  }

  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value)
    return { t: 'bytes', v: bytesToHex(bytes), n: bytes.length }
  }

  // Anything else (sql_variant payloads, geography, driver objects).
  try {
    return { t: 'json', v: JSON.stringify(value) ?? String(value) }
  } catch {
    return { t: 'json', v: String(value) }
  }
}

export function serializeRow(row: unknown[]): CellValue[] {
  return row.map(serializeCell)
}

/** IPC-safe value -> value suitable for binding as a query parameter. */
export function deserializeCell(value: CellValue): unknown {
  if (!isTagged(value)) return value

  const tagged = value as TaggedValue
  switch (tagged.t) {
    case 'date': {
      const date = new Date(tagged.v)
      return Number.isNaN(date.getTime()) ? tagged.v : date
    }
    case 'bytes':
      return hexToBytes(tagged.v)
    case 'bigint': {
      try {
        const asBigInt = BigInt(tagged.v)
        // Bind as a plain number when it is exactly representable.
        return asBigInt <= BigInt(Number.MAX_SAFE_INTEGER) &&
          asBigInt >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(asBigInt)
          : tagged.v
      } catch {
        return tagged.v
      }
    }
    case 'json':
      return tagged.v
  }
}

const DATE_ONLY = /^(date)$/i
const TIME_ONLY = /^(time)$/i

/**
 * Human-readable rendering for the grid.
 * `NULL` is returned as `null` so the caller can style it distinctly.
 */
export function formatCellForDisplay(value: CellValue, dataType?: string): string | null {
  if (value === null) return null

  if (isTagged(value)) {
    switch (value.t) {
      case 'date': {
        const iso = value.v
        if (dataType && DATE_ONLY.test(dataType)) return iso.slice(0, 10)
        if (dataType && TIME_ONLY.test(dataType)) return iso.slice(11, 23)
        return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`
      }
      case 'bytes': {
        const preview = value.v.slice(0, 32)
        return `0x${preview}${value.v.length > 32 ? `… (${value.n} bytes)` : ''}`
      }
      case 'bigint':
        return value.v
      case 'json':
        return value.v
    }
  }

  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** Full, untruncated text for the cell inspector and clipboard. */
export function formatCellFull(value: CellValue): string {
  if (value === null) return ''
  if (isTagged(value)) {
    if (value.t === 'bytes') return `0x${value.v}`
    return value.v
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** Parses text typed into a grid cell back into a `CellValue`. */
export function parseCellInput(text: string, jsKind: string): CellValue {
  if (text === '') return jsKind === 'string' ? '' : null

  switch (jsKind) {
    case 'number': {
      const trimmed = text.trim()
      const num = Number(trimmed)
      if (trimmed !== '' && Number.isFinite(num)) {
        if (!Number.isSafeInteger(num) && /^-?\d+$/.test(trimmed)) {
          return { t: 'bigint', v: trimmed }
        }
        return num
      }
      return text
    }
    case 'boolean': {
      const lowered = text.trim().toLowerCase()
      if (['true', '1', 'yes', 'y'].includes(lowered)) return true
      if (['false', '0', 'no', 'n'].includes(lowered)) return false
      return text
    }
    case 'date': {
      const date = new Date(text)
      return Number.isNaN(date.getTime()) ? text : { t: 'date', v: date.toISOString() }
    }
    case 'bytes': {
      const trimmed = text.trim()
      if (/^0x[0-9a-f]*$/i.test(trimmed)) {
        const hex = trimmed.slice(2)
        return { t: 'bytes', v: hex.toLowerCase(), n: hex.length / 2 }
      }
      return text
    }
    default:
      return text
  }
}

export { bytesToHex, hexToBytes }
