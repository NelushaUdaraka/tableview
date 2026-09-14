/**
 * Which cells are documents, and which only look like one.
 *
 * SQL Server has no JSON type, so the question is always about the text: the
 * row panel shows a tree for the columns that hold a document and leaves every
 * other value exactly as it was. Being wrong in the generous direction is the
 * expensive one — a column of numbers rendered as "documents" would be worse
 * than no tree at all.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_JSON_LENGTH,
  entriesOf,
  isContainer,
  kindOf,
  parseJsonCell,
  previewOf,
  scalarText
} from '../../../src/renderer/src/lib/jsonCell'

describe('parseJsonCell', () => {
  it('reads an object', () => {
    expect(parseJsonCell('{"id":1,"name":"Ada"}')).toEqual({ id: 1, name: 'Ada' })
  })

  it('reads an array', () => {
    expect(parseJsonCell('[1, 2, 3]')).toEqual([1, 2, 3])
  })

  it('reads a document stored with whitespace around it', () => {
    expect(parseJsonCell('\n  { "ok": true }\n')).toEqual({ ok: true })
  })

  it('leaves scalars alone, valid JSON though they are', () => {
    // A tree of one line says nothing the field did not already say, and every
    // number in the table is valid JSON.
    expect(parseJsonCell('42')).toBeNull()
    expect(parseJsonCell('true')).toBeNull()
    expect(parseJsonCell('null')).toBeNull()
    expect(parseJsonCell('"a quoted word"')).toBeNull()
  })

  it('leaves text that only starts like a document', () => {
    expect(parseJsonCell('{not json at all')).toBeNull()
    expect(parseJsonCell('{"id": 1')).toBeNull()
    expect(parseJsonCell('[1, 2,')).toBeNull()
  })

  it('leaves ordinary text, and empty text', () => {
    expect(parseJsonCell('a note about the customer')).toBeNull()
    expect(parseJsonCell('')).toBeNull()
    expect(parseJsonCell('   ')).toBeNull()
  })

  it('leaves a document too large to be worth a tree', () => {
    const huge = `[${'1,'.repeat(MAX_JSON_LENGTH)}1]`

    expect(huge.length).toBeGreaterThan(MAX_JSON_LENGTH)
    expect(parseJsonCell(huge)).toBeNull()
  })
})

describe('entriesOf', () => {
  it('keys an object by its properties', () => {
    expect(entriesOf({ a: 1, b: 'two' })).toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: 'two' }
    ])
  })

  it('keys an array by position', () => {
    expect(entriesOf(['x', 'y'])).toEqual([
      { key: '0', value: 'x' },
      { key: '1', value: 'y' }
    ])
  })

  it('finds nothing inside a scalar', () => {
    expect(entriesOf(7)).toEqual([])
    expect(entriesOf(null)).toEqual([])
  })
})

describe('previewOf', () => {
  it('says how much a closed container is holding', () => {
    expect(previewOf({ a: 1, b: 2, c: 3 })).toBe('{3}')
    expect(previewOf([1, 2])).toBe('[2]')
  })

  it('says when it is holding nothing', () => {
    expect(previewOf({})).toBe('{}')
    expect(previewOf([])).toBe('[]')
  })
})

describe('scalarText', () => {
  it('writes a value the way JSON does, so a string looks like one', () => {
    expect(scalarText('done')).toBe('"done"')
    expect(scalarText(12.5)).toBe('12.5')
    expect(scalarText(false)).toBe('false')
    expect(scalarText(null)).toBe('null')
  })

  it('keeps a string that needs escaping readable', () => {
    expect(scalarText('a "quote"')).toBe('"a \\"quote\\""')
  })
})

describe('kindOf', () => {
  it('separates the containers from the values', () => {
    expect(kindOf({})).toBe('container')
    expect(kindOf([])).toBe('container')
    expect(kindOf('x')).toBe('string')
    expect(kindOf(1)).toBe('number')
    expect(kindOf(true)).toBe('boolean')
    // Null is an object to `typeof`, and a value to everyone else.
    expect(kindOf(null)).toBe('null')
    expect(isContainer(null)).toBe(false)
  })
})
