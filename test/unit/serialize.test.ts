import { describe, expect, it } from 'vitest'
import {
  bytesToHex,
  deserializeCell,
  formatCellForDisplay,
  formatCellFull,
  hexToBytes,
  parseCellInput,
  serializeCell,
  serializeRow
} from '../../src/shared/serialize'

describe('serializeCell', () => {
  it('passes primitives through', () => {
    expect(serializeCell('text')).toBe('text')
    expect(serializeCell(42)).toBe(42)
    expect(serializeCell(0)).toBe(0)
    expect(serializeCell(true)).toBe(true)
    expect(serializeCell(false)).toBe(false)
    expect(serializeCell('')).toBe('')
  })

  it('normalises null and undefined to null', () => {
    expect(serializeCell(null)).toBeNull()
    expect(serializeCell(undefined)).toBeNull()
  })

  it('keeps non-finite numbers legible as text', () => {
    expect(serializeCell(NaN)).toBe('NaN')
    expect(serializeCell(Infinity)).toBe('Infinity')
    expect(serializeCell(-Infinity)).toBe('-Infinity')
  })

  it('tags dates with their ISO form', () => {
    const date = new Date('2024-06-01T12:34:56.123Z')
    expect(serializeCell(date)).toEqual({ t: 'date', v: '2024-06-01T12:34:56.123Z' })
  })

  it('turns an invalid date into null', () => {
    expect(serializeCell(new Date('nonsense'))).toBeNull()
  })

  it('tags binary data as hex', () => {
    expect(serializeCell(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toEqual({
      t: 'bytes',
      v: 'deadbeef',
      n: 4
    })
    expect(serializeCell(Buffer.from([0x01, 0x02]))).toEqual({ t: 'bytes', v: '0102', n: 2 })
    expect(serializeCell(new Uint8Array([]))).toEqual({ t: 'bytes', v: '', n: 0 })
  })

  it('tags bigints as text so precision survives', () => {
    expect(serializeCell(9007199254740993n)).toEqual({ t: 'bigint', v: '9007199254740993' })
  })

  it('falls back to JSON for anything else', () => {
    expect(serializeCell({ a: 1 })).toEqual({ t: 'json', v: '{"a":1}' })
  })

  it('serialises a whole row', () => {
    expect(serializeRow([1, 'a', null])).toEqual([1, 'a', null])
  })
})

describe('deserializeCell', () => {
  it('returns primitives unchanged', () => {
    expect(deserializeCell('a')).toBe('a')
    expect(deserializeCell(1)).toBe(1)
    expect(deserializeCell(null)).toBeNull()
  })

  it('rebuilds a Date', () => {
    const value = deserializeCell({ t: 'date', v: '2024-06-01T12:34:56.000Z' })
    expect(value).toBeInstanceOf(Date)
    expect((value as Date).toISOString()).toBe('2024-06-01T12:34:56.000Z')
  })

  it('keeps an unparseable date as its text', () => {
    expect(deserializeCell({ t: 'date', v: 'not-a-date' })).toBe('not-a-date')
  })

  it('rebuilds bytes', () => {
    const value = deserializeCell({ t: 'bytes', v: 'deadbeef', n: 4 })
    expect(value).toBeInstanceOf(Uint8Array)
    expect([...(value as Uint8Array)]).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('narrows a small bigint to a number and keeps a large one as text', () => {
    expect(deserializeCell({ t: 'bigint', v: '42' })).toBe(42)
    expect(deserializeCell({ t: 'bigint', v: '9007199254740993' })).toBe('9007199254740993')
  })

  it('round-trips every tagged kind', () => {
    const original = [
      new Date('2024-01-01T00:00:00.000Z'),
      new Uint8Array([1, 2, 3]),
      'text',
      7,
      true,
      null
    ]
    const restored = original.map((value) => deserializeCell(serializeCell(value)))
    expect(restored[0]).toEqual(original[0])
    expect([...(restored[1] as Uint8Array)]).toEqual([1, 2, 3])
    expect(restored.slice(2)).toEqual(['text', 7, true, null])
  })
})

describe('hex helpers', () => {
  it('converts in both directions', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff')
    expect([...hexToBytes('000fff')]).toEqual([0, 15, 255])
    expect([...hexToBytes('0x0A')]).toEqual([10])
  })

  it('rejects malformed hex', () => {
    expect(() => hexToBytes('abc')).toThrow(/even length/)
    expect(() => hexToBytes('zz')).toThrow(/Invalid hex/)
  })
})

describe('formatCellForDisplay', () => {
  it('returns null for NULL so the caller can style it', () => {
    expect(formatCellForDisplay(null)).toBeNull()
  })

  it('formats dates by column type', () => {
    const value = { t: 'date' as const, v: '2024-06-01T12:34:56.123Z' }
    expect(formatCellForDisplay(value, 'date')).toBe('2024-06-01')
    expect(formatCellForDisplay(value, 'time')).toBe('12:34:56.123')
    expect(formatCellForDisplay(value, 'datetime2')).toBe('2024-06-01 12:34:56.123')
  })

  it('abbreviates long binary values', () => {
    const long = { t: 'bytes' as const, v: 'ab'.repeat(40), n: 40 }
    const text = formatCellForDisplay(long)!
    expect(text.startsWith('0x')).toBe(true)
    expect(text).toContain('40 bytes')

    expect(formatCellForDisplay({ t: 'bytes', v: 'deadbeef', n: 4 })).toBe('0xdeadbeef')
  })

  it('renders booleans and numbers', () => {
    expect(formatCellForDisplay(true)).toBe('true')
    expect(formatCellForDisplay(false)).toBe('false')
    expect(formatCellForDisplay(0)).toBe('0')
  })
})

describe('formatCellFull', () => {
  it('gives the untruncated text', () => {
    expect(formatCellFull({ t: 'bytes', v: 'ab'.repeat(40), n: 40 })).toBe(`0x${'ab'.repeat(40)}`)
    expect(formatCellFull(null)).toBe('')
    expect(formatCellFull({ t: 'bigint', v: '9007199254740993' })).toBe('9007199254740993')
  })
})

describe('parseCellInput', () => {
  it('maps empty text to NULL, except for string columns', () => {
    expect(parseCellInput('', 'number')).toBeNull()
    expect(parseCellInput('', 'string')).toBe('')
  })

  it('parses numbers and keeps oversized integers exact', () => {
    expect(parseCellInput('42', 'number')).toBe(42)
    expect(parseCellInput('-1.5', 'number')).toBe(-1.5)
    expect(parseCellInput('9007199254740993', 'number')).toEqual({
      t: 'bigint',
      v: '9007199254740993'
    })
  })

  it('keeps non-numeric text for a numeric column so the server can complain', () => {
    expect(parseCellInput('abc', 'number')).toBe('abc')
  })

  it('parses booleans generously', () => {
    expect(parseCellInput('true', 'boolean')).toBe(true)
    expect(parseCellInput('1', 'boolean')).toBe(true)
    expect(parseCellInput('YES', 'boolean')).toBe(true)
    expect(parseCellInput('false', 'boolean')).toBe(false)
    expect(parseCellInput('0', 'boolean')).toBe(false)
    expect(parseCellInput('maybe', 'boolean')).toBe('maybe')
  })

  it('parses dates', () => {
    expect(parseCellInput('2024-06-01', 'date')).toEqual({
      t: 'date',
      v: '2024-06-01T00:00:00.000Z'
    })
    expect(parseCellInput('nope', 'date')).toBe('nope')
  })

  it('parses hex for binary columns', () => {
    expect(parseCellInput('0xDEADBEEF', 'bytes')).toEqual({ t: 'bytes', v: 'deadbeef', n: 4 })
    expect(parseCellInput('not hex', 'bytes')).toBe('not hex')
  })
})
