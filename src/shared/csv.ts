/**
 * Reading delimited text: a CSV file to import, or a range pasted from a
 * spreadsheet (which arrives tab-separated).
 *
 * RFC 4180 with the liberties real files take: a field in double quotes may
 * hold the delimiter, line breaks and `""` for a quote; lines end in CRLF, LF
 * or CR; a byte-order mark at the start is not data; and the delimiter can be
 * a comma, a semicolon (Excel's CSV where the decimal separator is a comma)
 * or a tab, found from the first lines when not given.
 */

export type Delimiter = ',' | ';' | '\t' | '|'

export const DELIMITERS: readonly { value: Delimiter; label: string }[] = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe' }
]

export interface ParsedText {
  rows: string[][]
  delimiter: Delimiter
}

/**
 * The delimiter a file most likely uses: the candidate that splits the first
 * few lines into the same number of fields — more than one — most often,
 * counted outside quotes.
 */
export function detectDelimiter(text: string): Delimiter {
  const sample = text.replace(/^﻿/, '').slice(0, 20_000)
  let best: Delimiter = ','
  let bestScore = -1
  for (const { value } of DELIMITERS) {
    const rows = parseDelimited(sample, value).rows.slice(0, 10)
    // The last line of a sample may be cut short.
    const counted = rows.length > 1 ? rows.slice(0, -1) : rows
    const widths = counted.map((row) => row.length)
    const first = widths[0] ?? 1
    if (first < 2) continue
    const consistent = widths.filter((width) => width === first).length
    const score = consistent * 100 + first
    if (score > bestScore) {
      best = value
      bestScore = score
    }
  }
  return best
}

/** Splits delimited text into rows of fields. Blank lines are skipped. */
export function parseDelimited(text: string, delimiter?: Delimiter): ParsedText {
  const source = text.replace(/^﻿/, '')
  const sep = delimiter ?? detectDelimiter(source)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  /** The field started with a quote, so what follows its closing quote is kept as is. */
  let wasQuoted = false

  const endField = (): void => {
    row.push(field)
    field = ''
    wasQuoted = false
  }
  const endRow = (): void => {
    endField()
    // A line with nothing on it is not a row of one empty field.
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '' && !wasQuoted) {
      quoted = true
      wasQuoted = true
    } else if (char === sep) {
      endField()
    } else if (char === '\r') {
      if (source[index + 1] === '\n') index += 1
      endRow()
    } else if (char === '\n') {
      endRow()
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0 || wasQuoted) endRow()
  return { rows, delimiter: sep }
}

/**
 * The text of a file, whatever it was saved as: UTF-8 (with or without a
 * byte-order mark), UTF-16 with one — Excel's "Unicode text" — or, when the
 * bytes are not valid UTF-8, Windows-1252, which is what Excel's plain CSV is
 * on most Western Windows machines.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    return decodeWindows1252(body)
  }
}

/**
 * Windows-1252's 0x80–0x9F, where it differs from Latin-1: Node's decoder for
 * the label gives Latin-1's control characters there, not `€`, `‘`, `’`, `–`
 * and the rest. Bytes the code page leaves undefined stay as they were.
 */
const CP1252_HIGH =
  '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F' +
  '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178'

function decodeWindows1252(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out += byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : String.fromCharCode(byte)
  }
  return out
}
