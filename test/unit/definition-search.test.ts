import { describe, expect, it } from 'vitest'
import {
  containsPattern,
  matchingLines,
  moduleKindOf,
  moduleTypeOf
} from '../../src/shared/sql/definitionSearch'

const PROC = [
  'CREATE PROCEDURE dbo.usp_orders',
  'AS',
  'BEGIN',
  '  SELECT order_id, Total FROM dbo.orders;',
  '  UPDATE dbo.orders_archive SET total = 0;',
  'END'
].join('\r\n')

describe('containsPattern', () => {
  it('escapes LIKE wildcards and wraps the text in %', () => {
    expect(containsPattern('100%_[x]')).toBe('%100\\%\\_\\[x\\]%')
  })
})

describe('matchingLines', () => {
  it('numbers lines from 1 the way the editor does, across \\r\\n', () => {
    const { lines } = matchingLines(PROC, 'orders')
    expect(lines.map((line) => line.line)).toEqual([1, 4, 5])
  })

  it('ignores case unless asked not to', () => {
    expect(matchingLines(PROC, 'TOTAL').lines.map((l) => l.line)).toEqual([4, 5])
    expect(matchingLines(PROC, 'Total', { matchCase: true }).lines.map((l) => l.line)).toEqual([4])
  })

  it('matches a whole word only where it is not part of a longer identifier', () => {
    const { lines } = matchingLines(PROC, 'orders', { wholeWord: true })
    expect(lines.map((line) => line.line)).toEqual([4])
    // `_` and `@` belong to identifiers; `.` and `[` do not.
    expect(matchingLines('SET @orders = 1', 'orders', { wholeWord: true }).lines).toEqual([])
    expect(matchingLines('FROM [orders]', 'orders', { wholeWord: true }).lines).toHaveLength(1)
  })

  it('treats the search text literally', () => {
    expect(matchingLines('a.b axb', 'a.b').lines[0].ranges).toEqual([[0, 3]])
    expect(matchingLines('x (y) z', '(y)').lines[0].ranges).toEqual([[2, 5]])
  })

  it('drops indentation and moves the ranges with it', () => {
    const [line] = matchingLines(PROC, 'Total', { matchCase: true }).lines
    expect(line.text).toBe('SELECT order_id, Total FROM dbo.orders;')
    expect(line.text.slice(...line.ranges[0])).toBe('Total')
  })

  it('cuts a long line down around its first match', () => {
    const long = `${'x'.repeat(500)} needle ${'y'.repeat(500)}`
    const [line] = matchingLines(long, 'needle').lines
    expect(line.text.length).toBeLessThan(260)
    expect(line.text.startsWith('…')).toBe(true)
    expect(line.text.endsWith('…')).toBe(true)
    expect(line.text.slice(...line.ranges[0])).toBe('needle')
  })

  it('keeps a limited number of lines and counts the rest', () => {
    const text = Array.from({ length: 8 }, () => 'hit').join('\n')
    const result = matchingLines(text, 'hit', { maxLines: 3 })
    expect(result.lines).toHaveLength(3)
    expect(result.moreLines).toBe(5)
  })

  it('finds nothing for empty text', () => {
    expect(matchingLines(PROC, '')).toEqual({ lines: [], moreLines: 0 })
  })
})

describe('module types', () => {
  it('maps sys.objects codes, which come padded', () => {
    expect(moduleTypeOf('P ')).toBe('procedure')
    expect(moduleTypeOf('FN')).toBe('scalar-function')
    expect(moduleTypeOf('IF')).toBe('table-function')
    expect(moduleTypeOf('TF')).toBe('table-function')
    expect(moduleTypeOf('V ')).toBe('view')
    expect(moduleTypeOf('TR')).toBe('trigger')
    expect(moduleTypeOf('U ')).toBeNull()
  })

  it('folds both kinds of function into one', () => {
    expect(moduleKindOf('table-function')).toBe('function')
    expect(moduleKindOf('view')).toBe('view')
  })
})
