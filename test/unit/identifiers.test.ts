import { describe, expect, it } from 'vitest'
import {
  escapeLikePattern,
  isPlainIdentifier,
  maybeQuoteIdent,
  parseQualifiedName,
  qualify,
  qualifyWithDatabase,
  quoteIdent,
  quoteString
} from '../../src/shared/sql/identifiers'

describe('quoteIdent', () => {
  it('wraps a plain identifier in brackets', () => {
    expect(quoteIdent('customers')).toBe('[customers]')
  })

  it('doubles a closing bracket so it cannot end the identifier early', () => {
    expect(quoteIdent('weird ] table')).toBe('[weird ]] table]')
    expect(quoteIdent(']]')).toBe('[]]]]]')
  })

  it('leaves other punctuation alone', () => {
    expect(quoteIdent("O'Brien")).toBe("[O'Brien]")
    expect(quoteIdent('a.b')).toBe('[a.b]')
    expect(quoteIdent('[x')).toBe('[[x]')
  })

  it('rejects empty identifiers and null bytes', () => {
    expect(() => quoteIdent('')).toThrow(/non-empty/)
    expect(() => quoteIdent('a\0b')).toThrow(/null byte/)
  })
})

describe('qualify', () => {
  it('joins schema and object', () => {
    expect(qualify('dbo', 'customers')).toBe('[dbo].[customers]')
  })

  it('omits the schema when absent', () => {
    expect(qualify(undefined, 'customers')).toBe('[customers]')
    expect(qualify('', 'customers')).toBe('[customers]')
  })

  it('escapes both parts', () => {
    expect(qualify('odd name', 'weird ] table')).toBe('[odd name].[weird ]] table]')
  })

  it('adds the database when given one', () => {
    expect(qualifyWithDatabase('db', 'dbo', 't')).toBe('[db].[dbo].[t]')
    // A database with no schema still needs the empty middle part.
    expect(qualifyWithDatabase('db', null, 't')).toBe('[db]..[t]')
  })
})

describe('quoteString', () => {
  it('doubles single quotes', () => {
    expect(quoteString("O'Brien")).toBe("N'O''Brien'")
  })

  it('can omit the unicode prefix', () => {
    expect(quoteString('plain', false)).toBe("'plain'")
  })

  it('neutralises a quote-and-comment injection attempt', () => {
    expect(quoteString("x'; DROP TABLE t; --")).toBe("N'x''; DROP TABLE t; --'")
  })
})

describe('escapeLikePattern', () => {
  it('escapes wildcards and bracket ranges', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%')
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
    expect(escapeLikePattern('[abc]')).toBe('\\[abc\\]')
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeLikePattern('plain text')).toBe('plain text')
  })
})

describe('isPlainIdentifier / maybeQuoteIdent', () => {
  it('accepts ordinary names', () => {
    expect(isPlainIdentifier('customers')).toBe(true)
    expect(isPlainIdentifier('_private')).toBe(true)
    expect(isPlainIdentifier('col1')).toBe(true)
    expect(isPlainIdentifier('café')).toBe(true)
  })

  it('rejects names needing quotes', () => {
    expect(isPlainIdentifier('has space')).toBe(false)
    expect(isPlainIdentifier('1abc')).toBe(false)
    expect(isPlainIdentifier('')).toBe(false)
  })

  it('rejects reserved words regardless of case', () => {
    expect(isPlainIdentifier('SELECT')).toBe(false)
    expect(isPlainIdentifier('select')).toBe(false)
    expect(isPlainIdentifier('Order')).toBe(false)
  })

  it('quotes only what needs it', () => {
    expect(maybeQuoteIdent('customers')).toBe('customers')
    expect(maybeQuoteIdent('has space')).toBe('[has space]')
    expect(maybeQuoteIdent('select')).toBe('[select]')
  })
})

describe('parseQualifiedName', () => {
  it('splits an unquoted name', () => {
    expect(parseQualifiedName('dbo.customers')).toEqual(['dbo', 'customers'])
  })

  it('splits a bracketed name', () => {
    expect(parseQualifiedName('[dbo].[customers]')).toEqual(['dbo', 'customers'])
  })

  it('keeps dots that are inside brackets', () => {
    expect(parseQualifiedName('[my.schema].[my.table]')).toEqual(['my.schema', 'my.table'])
  })

  it('unescapes doubled brackets', () => {
    expect(parseQualifiedName('[odd name].[weird ]] table]')).toEqual([
      'odd name',
      'weird ] table'
    ])
  })

  it('handles three parts', () => {
    expect(parseQualifiedName('db.dbo.t')).toEqual(['db', 'dbo', 't'])
  })
})
