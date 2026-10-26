/**
 * The figures shown for the selected rows: a count for any column, and the
 * sum, average, minimum and maximum of a numeric one.
 *
 * Values arrive as they crossed IPC — a bigint as tagged text, a decimal as a
 * JS number — so the arithmetic is done on decimal digits rather than on
 * floats, or 0.1 + 0.2 would come out as 0.30000000000000004.
 */
import { describe, expect, it } from 'vitest'
import {
  figureParts,
  formatDecimal,
  parseDecimal,
  selectionFigures
} from '../../../src/renderer/src/lib/selectionFigures'
import type { CellValue } from '../../../src/shared/types'

describe('parseDecimal', () => {
  it('reads integers, decimals and exponents exactly', () => {
    expect(parseDecimal('42')).toEqual({ digits: 42n, scale: 0 })
    expect(parseDecimal('-9.99')).toEqual({ digits: -999n, scale: 2 })
    expect(parseDecimal('1e-7')).toEqual({ digits: 1n, scale: 7 })
    expect(parseDecimal('1.5e3')).toEqual({ digits: 1500n, scale: 0 })
    expect(parseDecimal('123456789012345678901234567890')).toEqual({
      digits: 123456789012345678901234567890n,
      scale: 0
    })
  })

  it('refuses what is not a number', () => {
    expect(parseDecimal('abc')).toBeNull()
    expect(parseDecimal('')).toBeNull()
    expect(parseDecimal('1.2.3')).toBeNull()
  })
})

describe('formatDecimal', () => {
  it('groups thousands and keeps the scale', () => {
    expect(formatDecimal({ digits: 431050n, scale: 2 })).toBe('4,310.50')
    expect(formatDecimal({ digits: -1234567n, scale: 0 })).toBe('-1,234,567')
    expect(formatDecimal({ digits: 5n, scale: 3 })).toBe('0.005')
    expect(formatDecimal({ digits: -5n, scale: 3 })).toBe('-0.005')
  })
})

describe('selectionFigures', () => {
  const pick = (values: CellValue[]): CellValue[] => values

  it('adds decimals without float error', () => {
    const figures = selectionFigures(pick([0.1, 0.2]), 'number')
    expect(figures.numeric).toBe(true)
    expect(figures.sum).toBe('0.3')
    expect(figures.avg).toBe('0.15')
    expect(figures.count).toBe(2)
  })

  it('gives sum, average, minimum and maximum of a numeric column', () => {
    const figures = selectionFigures(pick([9.99, 1200, 3100.51]), 'number')
    expect(figures).toMatchObject({
      rows: 3,
      count: 3,
      nulls: 0,
      numeric: true,
      sum: '4,310.50',
      avg: '1,436.83',
      min: '9.99',
      max: '3,100.51'
    })
  })

  it('keeps bigints exact past 2^53', () => {
    const big: CellValue = { t: 'bigint', v: '9007199254740993' }
    const figures = selectionFigures(pick([big, big]), 'number')
    expect(figures.sum).toBe('18,014,398,509,481,986')
    expect(figures.max).toBe('9,007,199,254,740,993')
    expect(figures.avg).toBe('9,007,199,254,740,993')
  })

  it('skips NULLs in the figures and counts them apart', () => {
    const figures = selectionFigures(pick([10, null, 20, null]), 'number')
    expect(figures).toMatchObject({ rows: 4, count: 2, nulls: 2, sum: '30', avg: '15' })
  })

  it('rounds an average of integers to two places, and drops trailing zeros', () => {
    expect(selectionFigures(pick([1, 2]), 'number').avg).toBe('1.5')
    expect(selectionFigures(pick([1, 1, 2]), 'number').avg).toBe('1.33')
    expect(selectionFigures(pick([-1, -1, -2]), 'number').avg).toBe('-1.33')
    expect(selectionFigures(pick([2, 4]), 'number').avg).toBe('3')
  })

  it('gives only counts, and the distinct count, for anything else', () => {
    const figures = selectionFigures(pick(['a', 'b', 'a', null]), 'string')
    expect(figures).toMatchObject({ numeric: false, count: 3, nulls: 1, distinct: 2 })
    expect(figures.sum).toBeUndefined()
  })

  it('treats a numeric column with a non-number in it as text', () => {
    // A cell typed into as text, not yet applied.
    const figures = selectionFigures(pick([1, 'oops']), 'number')
    expect(figures.numeric).toBe(false)
    expect(figures.distinct).toBe(2)
  })

  it('reads a query column of unknown type as numeric when every value is', () => {
    expect(selectionFigures(pick([1, 2]), 'unknown').numeric).toBe(true)
  })

  it('does not add booleans up', () => {
    expect(selectionFigures(pick([true, false, true]), 'boolean')).toMatchObject({
      numeric: false,
      distinct: 2
    })
  })

  it('has nothing to add when every value is NULL', () => {
    const figures = selectionFigures(pick([null, null]), 'number')
    expect(figures).toMatchObject({ count: 0, nulls: 2, numeric: false })
  })

  it('tells tagged values apart by what they hold', () => {
    const day = (v: string): CellValue => ({ t: 'date', v })
    const figures = selectionFigures(
      pick([day('2024-01-01T00:00:00.000Z'), day('2024-01-01T00:00:00.000Z'), day('2024-01-02T00:00:00.000Z')]),
      'date'
    )
    expect(figures.distinct).toBe(2)
  })
})

describe('figureParts', () => {
  it('lists the figures in the order a spreadsheet does', () => {
    const parts = figureParts(selectionFigures([10, 20, null], 'number'))
    expect(parts).toEqual([
      { label: 'Count', value: '2' },
      { label: 'Sum', value: '30' },
      { label: 'Avg', value: '15' },
      { label: 'Min', value: '10' },
      { label: 'Max', value: '20' },
      { label: 'NULL', value: '1' }
    ])
  })

  it('lists the count and distinct count for text', () => {
    expect(figureParts(selectionFigures(['a', 'a'], 'string'))).toEqual([
      { label: 'Count', value: '2' },
      { label: 'Distinct', value: '1' }
    ])
  })
})
