/**
 * Delimited text as files and spreadsheets actually write it: quoted fields
 * holding delimiters, line breaks and doubled quotes; CRLF; a byte-order mark;
 * and a delimiter worked out from the text when it is not given.
 */
import { describe, expect, it } from 'vitest'
import { decodeText, detectDelimiter, parseDelimited } from '../../src/shared/csv'

describe('parseDelimited', () => {
  it('splits plain rows', () => {
    expect(parseDelimited('a,b,c\n1,2,3\n', ',').rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ])
  })

  it('reads quoted fields with delimiters, line breaks and doubled quotes', () => {
    const text = 'name,note\r\n"Smith, J","said ""hi""\r\nthen left"\r\nplain,""\r\n'
    expect(parseDelimited(text, ',').rows).toEqual([
      ['name', 'note'],
      ['Smith, J', 'said "hi"\r\nthen left'],
      ['plain', '']
    ])
  })

  it('keeps empty fields, including trailing ones', () => {
    expect(parseDelimited('a,,c,\n', ',').rows).toEqual([['a', '', 'c', '']])
  })

  it('skips blank lines and a byte-order mark', () => {
    expect(parseDelimited('﻿a,b\n\n1,2\n\n', ',').rows).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('reads a range copied from a spreadsheet, tab-separated', () => {
    const text = 'id\tlabel\n1\t"two\nlines"\n2\tplain'
    expect(parseDelimited(text, '\t').rows).toEqual([
      ['id', 'label'],
      ['1', 'two\nlines'],
      ['2', 'plain']
    ])
  })

  it('takes a lone CR as a line end', () => {
    expect(parseDelimited('a,b\r1,2', ',').rows).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('reads a quote in the middle of a field as a quote', () => {
    expect(parseDelimited('5" pipe,x\n', ',').rows).toEqual([['5" pipe', 'x']])
  })
})

describe('detectDelimiter', () => {
  it('finds commas, semicolons, tabs and pipes', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',')
    expect(detectDelimiter('a;b;c\n1,5;2,5;3\n')).toBe(';')
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t')
    expect(detectDelimiter('a|b\n1|2\n')).toBe('|')
  })

  it('is not fooled by commas inside quotes', () => {
    expect(detectDelimiter('"a,b";c\n"1,2";3\n')).toBe(';')
  })

  it('is used when no delimiter is given', () => {
    expect(parseDelimited('a;b\n1;2').delimiter).toBe(';')
  })
})

describe('decodeText', () => {
  const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

  it('reads UTF-8, with or without a byte-order mark', () => {
    expect(decodeText(new TextEncoder().encode('café'))).toBe('café')
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe('a')
  })

  it('reads UTF-16 with a byte-order mark', () => {
    expect(decodeText(bytes(0xff, 0xfe, 0x61, 0x00, 0xe9, 0x00))).toBe('aé')
    expect(decodeText(bytes(0xfe, 0xff, 0x00, 0x61))).toBe('a')
  })

  it('falls back to Windows-1252 when the bytes are not UTF-8', () => {
    expect(decodeText(bytes(0x63, 0x61, 0x66, 0xe9, 0x80))).toBe('café€')
  })
})
