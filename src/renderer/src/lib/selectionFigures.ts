/**
 * Figures for the selected rows, the way a spreadsheet's status bar gives
 * them: how many values the focused column holds over those rows, and for a
 * numeric column their sum, average, minimum and maximum.
 *
 * The arithmetic is done on decimal digits, not on floats. A bigint crosses
 * IPC as text precisely so it keeps every digit, and a `decimal(18, 2)` or a
 * `money` arrives as a JS number whose shortest text is the value the server
 * holds — adding the numbers themselves would turn 0.1 + 0.2 into
 * 0.30000000000000004, which is not what any of those columns contain.
 */
import type { CellValue, JsKind } from '@shared/types'
import { isTagged } from '@shared/types'

/** A decimal number as an integer of digits and how many of them follow the point. */
export interface Decimal {
  digits: bigint
  scale: number
}

export interface SelectionFigures {
  /** Rows the figures are over. */
  rows: number
  /** Values that are not NULL. */
  count: number
  nulls: number
  /** True when every value counted is a number, so the arithmetic means something. */
  numeric: boolean
  /** Different values among those counted, for a column that is not numeric. */
  distinct?: number
  sum?: string
  avg?: string
  min?: string
  max?: string
}

/** Past this many places a float is better added as a float than spelled out. */
const MAX_SCALE = 20

const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i

/** Reads a number's text exactly, exponent and all; null when it is not a number. */
export function parseDecimal(text: string): Decimal | null {
  const match = DECIMAL_TEXT.exec(text.trim())
  if (!match) return null
  const [, sign, whole, fraction = '', exponentText] = match
  if (whole === '' && fraction === '') return null
  const exponent = exponentText ? Number(exponentText) : 0
  let digits = BigInt(`${whole}${fraction}` || '0')
  let scale = fraction.length - exponent
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale)
    scale = 0
  }
  if (sign === '-') digits = -digits
  return { digits, scale }
}

/** The value at `scale` places, rounding half away from zero when it loses some. */
function rescale(value: Decimal, scale: number): bigint {
  if (scale >= value.scale) return value.digits * 10n ** BigInt(scale - value.scale)
  const divisor = 10n ** BigInt(value.scale - scale)
  return divide(value.digits, divisor)
}

/** Integer division rounding half away from zero. */
function divide(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  const quotient = (n * 2n + d) / (d * 2n)
  return negative ? -quotient : quotient
}

/** `4,310.50`: grouped in thousands, with the scale's places after the point. */
export function formatDecimal(value: Decimal): string {
  const negative = value.digits < 0n
  const text = (negative ? -value.digits : value.digits).toString().padStart(value.scale + 1, '0')
  const whole = text.slice(0, text.length - value.scale)
  const fraction = text.slice(text.length - value.scale)
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${grouped}${value.scale > 0 ? `.${fraction}` : ''}`
}

/**
 * A cell as a decimal, when it holds a number. The driver hands a `bigint`
 * over as its digits in a string, so in a numeric column a string of digits
 * is a number too; anything else typed into one is not.
 */
function decimalOf(value: CellValue, kind: JsKind): Decimal | null {
  if (typeof value === 'number') return Number.isFinite(value) ? parseDecimal(String(value)) : null
  if (isTagged(value) && value.t === 'bigint') return parseDecimal(value.v)
  if (typeof value === 'string' && kind === 'number' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    return parseDecimal(value)
  }
  return null
}

/**
 * How many places the column's type keeps: a `decimal(10, 2)` holding 1200
 * arrives as the number 1200, and its figures should still read `1,200.00`.
 * Money keeps four, but is read with two unless the values have more.
 */
export function declaredScale(dataType: string | undefined): number {
  if (!dataType) return 0
  const decimal = /^(?:decimal|numeric)\s*\(\s*\d+\s*,\s*(\d+)\s*\)/i.exec(dataType.trim())
  if (decimal) return Number(decimal[1])
  return /^(?:small)?money$/i.test(dataType.trim()) ? 2 : 0
}

/** What makes two values the same value, for the distinct count. */
function identity(value: CellValue): string {
  if (isTagged(value)) return `${value.t}:${value.v}`
  return `${typeof value}:${String(value)}`
}

/**
 * The figures for one column's values over the selected rows.
 *
 * `kind` is the column's type as the grid knows it. A column that says it is
 * numeric but holds something else — a cell typed into and not yet applied —
 * is counted as text rather than added up wrongly; a query's column of
 * unknown type is numeric when every value in it is. `dataType` is the
 * column's declared type, which says how many places the figures keep.
 */
export function selectionFigures(
  values: CellValue[],
  kind: JsKind,
  dataType?: string
): SelectionFigures {
  const present = values.filter((value) => value !== null && value !== undefined)
  const nulls = values.length - present.length
  const base = { rows: values.length, count: present.length, nulls }

  const mayBeNumeric = kind === 'number' || kind === 'unknown'
  const decimals = mayBeNumeric ? present.map((value) => decimalOf(value, kind)) : []
  const numeric =
    present.length > 0 && mayBeNumeric && decimals.every((value): value is Decimal => !!value)

  if (!numeric) {
    return { ...base, numeric: false, distinct: new Set(present.map(identity)).size }
  }

  const exact = decimals as Decimal[]
  const scale = Math.max(declaredScale(dataType), ...exact.map((value) => value.scale))
  if (scale > MAX_SCALE) return floatFigures(present as number[], base)

  const scaled = exact.map((value) => rescale(value, scale))
  const sum = scaled.reduce((total, value) => total + value, 0n)
  let min = scaled[0]
  let max = scaled[0]
  for (const value of scaled) {
    if (value < min) min = value
    if (value > max) max = value
  }

  // Two places at least, so an average of whole numbers can say 1.5; more
  // when the values have more, and none of the trailing zeros past theirs.
  const avgScale = Math.max(2, scale)
  const avgDigits = divide(sum * 10n ** BigInt(avgScale - scale), BigInt(scaled.length))
  const avg = trimZeros({ digits: avgDigits, scale: avgScale }, scale)

  return {
    ...base,
    numeric: true,
    sum: formatDecimal({ digits: sum, scale }),
    avg: formatDecimal(avg),
    min: formatDecimal({ digits: min, scale }),
    max: formatDecimal({ digits: max, scale })
  }
}

/** Drops trailing zeros after the point, keeping at least `keep` places. */
function trimZeros(value: Decimal, keep: number): Decimal {
  let { digits, scale } = value
  while (scale > keep && digits % 10n === 0n) {
    digits /= 10n
    scale -= 1
  }
  return { digits, scale }
}

/** For floats too small or too fine to spell out: plain float arithmetic. */
function floatFigures(
  values: number[],
  base: Pick<SelectionFigures, 'rows' | 'count' | 'nulls'>
): SelectionFigures {
  const sum = values.reduce((total, value) => total + value, 0)
  const show = (value: number): string => value.toPrecision(15).replace(/\.?0+(e|$)/, '$1')
  return {
    ...base,
    numeric: true,
    sum: show(sum),
    avg: show(sum / values.length),
    min: show(Math.min(...values)),
    max: show(Math.max(...values))
  }
}

export interface FigurePart {
  label: string
  value: string
}

/** The figures as the footer lists them: count first, as a spreadsheet does, NULLs last. */
export function figureParts(figures: SelectionFigures): FigurePart[] {
  const count = (n: number): string => formatDecimal({ digits: BigInt(n), scale: 0 })
  const parts: FigurePart[] = [{ label: 'Count', value: count(figures.count) }]
  if (figures.numeric) {
    parts.push(
      { label: 'Sum', value: figures.sum! },
      { label: 'Avg', value: figures.avg! },
      { label: 'Min', value: figures.min! },
      { label: 'Max', value: figures.max! }
    )
  } else if (figures.distinct !== undefined && figures.count > 0) {
    parts.push({ label: 'Distinct', value: count(figures.distinct) })
  }
  if (figures.nulls > 0) parts.push({ label: 'NULL', value: count(figures.nulls) })
  return parts
}
