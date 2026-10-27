/**
 * A file's rows as rows a table takes: columns matched by name, each value
 * read as its column's type, and every problem found before anything is sent.
 */
import { describe, expect, it } from 'vitest'
import {
  convertCell,
  importableColumns,
  matchColumns,
  planImport,
  positionalMapping,
  unfilledRequired
} from '../../src/shared/import'
import type { TableColumn } from '../../src/shared/types'

function column(name: string, dataType: string, patch: Partial<TableColumn> = {}): TableColumn {
  return {
    name,
    position: 0,
    dataType,
    fullType: dataType,
    maxLength: null,
    precision: null,
    scale: null,
    nullable: true,
    defaultValue: null,
    isIdentity: false,
    isComputed: false,
    isPrimaryKey: false,
    collation: null,
    description: null,
    ...patch
  }
}

const id = column('id', 'int', { isIdentity: true, nullable: false, isPrimaryKey: true })
const email = column('email', 'nvarchar', { maxLength: 40, nullable: false })
const credit = column('credit_limit', 'decimal', {
  precision: 6,
  scale: 2,
  fullType: 'decimal(6, 2)',
  nullable: false,
  defaultValue: '((0))'
})
const active = column('is_active', 'bit')
const joined = column('joined_on', 'date')
const total = column('total', 'int', { isComputed: true })
const version = column('row_version', 'timestamp', { nullable: false })
const table = [id, email, credit, active, joined, total, version]
const importable = importableColumns(table)

describe('importableColumns', () => {
  it('leaves out identity, computed and rowversion columns', () => {
    expect(importable.map((c) => c.name)).toEqual(['email', 'credit_limit', 'is_active', 'joined_on'])
  })
})

describe('matchColumns', () => {
  it('matches headers by name, ignoring case, spaces and underscores', () => {
    expect(matchColumns(['Email', 'Credit Limit', 'Notes', 'IS_ACTIVE'], importable)).toEqual({
      email: 0,
      credit_limit: 1,
      is_active: 3,
      joined_on: null
    })
  })

  it('takes columns in order when there is no header', () => {
    expect(positionalMapping(2, importable)).toEqual({
      email: 0,
      credit_limit: 1,
      is_active: null,
      joined_on: null
    })
  })
})

describe('convertCell', () => {
  it('reads integers, keeping ones past 2^53 as text, and refuses what is out of range', () => {
    expect(convertCell(' 42 ', column('n', 'int'), 'null')).toEqual({ value: 42 })
    expect(convertCell('9007199254740993', column('n', 'bigint'), 'null')).toEqual({
      value: '9007199254740993'
    })
    expect(convertCell('256', column('n', 'tinyint'), 'null')).toEqual({
      problem: '256 is out of range for tinyint'
    })
    expect(convertCell('4.5', column('n', 'int'), 'null')).toHaveProperty('problem')
  })

  it('keeps decimals exact as text, and refuses ones too large for the column', () => {
    expect(convertCell('1234.50', credit, 'null')).toEqual({ value: '1234.50' })
    expect(convertCell('12345.00', credit, 'null')).toEqual({ problem: '12345.00 is too large for decimal(6, 2)' })
    expect(convertCell('1,5', credit, 'null')).toHaveProperty('problem')
  })

  it('reads bits the ways spreadsheets write them', () => {
    expect(convertCell('TRUE', active, 'null')).toEqual({ value: true })
    expect(convertCell('0', active, 'null')).toEqual({ value: false })
    expect(convertCell('maybe', active, 'null')).toHaveProperty('problem')
  })

  it('checks dates, keeping their text for the server to read', () => {
    expect(convertCell('2024-03-01', joined, 'null')).toEqual({ value: '2024-03-01' })
    expect(convertCell('2024-13-45', joined, 'null')).toEqual({ problem: '“2024-13-45” is not a date' })
  })

  it('checks a text column’s length in characters', () => {
    expect(convertCell('a'.repeat(20), email, 'null')).toEqual({ value: 'a'.repeat(20) })
    expect(convertCell('a'.repeat(21), email, 'null')).toEqual({
      problem: 'is 21 characters, and the column holds 20'
    })
  })

  it('reads an empty cell as NULL or an empty string, as asked', () => {
    const notes = column('notes', 'nvarchar', { maxLength: -1 })
    expect(convertCell('', notes, 'null')).toEqual({ value: null })
    expect(convertCell('', notes, 'empty')).toEqual({ value: '' })
    // Only text columns take an empty string.
    expect(convertCell('', active, 'empty')).toEqual({ value: null })
  })

  it('leaves an empty NOT NULL column with a default out, so it takes the default', () => {
    expect(convertCell('', credit, 'null')).toEqual({ omit: true })
    expect(convertCell('', email, 'null')).toEqual({
      problem: 'is empty, and the column does not take NULL'
    })
  })

  it('reads GUIDs and binary', () => {
    const guid = '{6F9619FF-8B86-D011-B42D-00C04FC964FF}'
    expect(convertCell(guid, column('g', 'uniqueidentifier'), 'null')).toEqual({
      value: '6F9619FF-8B86-D011-B42D-00C04FC964FF'
    })
    expect(convertCell('0xFF00', column('b', 'varbinary'), 'null')).toEqual({
      value: { t: 'bytes', v: 'ff00', n: 2 }
    })
    expect(convertCell('ff', column('b', 'varbinary'), 'null')).toHaveProperty('problem')
  })
})

describe('unfilledRequired', () => {
  it('names NOT NULL columns with no default that nothing fills', () => {
    expect(unfilledRequired(importable, { email: null, credit_limit: null, is_active: 0, joined_on: null })).toEqual([
      'email'
    ])
  })
})

describe('planImport', () => {
  const records = [
    ['email', 'credit', 'active', 'joined'],
    ['ada@example.com', '100.00', 'yes', '2024-01-02'],
    ['bad@example.com', 'lots', 'no', ''],
    ['', '', '1', '2024-02-30x'],
    ['grace@example.com', '', 'false', '']
  ]
  const mapping = { email: 0, credit_limit: 1, is_active: 2, joined_on: 3 }

  it('converts every good row and lists each problem with its line and column', () => {
    const plan = planImport(records, { header: true, mapping, columns: importable, emptyAs: 'null' })
    expect(plan.rows).toEqual([
      {
        line: 2,
        values: { email: 'ada@example.com', credit_limit: '100.00', is_active: true, joined_on: '2024-01-02' }
      },
      { line: 5, values: { email: 'grace@example.com', is_active: false, joined_on: null } }
    ])
    expect(plan.rejected).toBe(2)
    expect(plan.problems).toEqual([
      { line: 3, column: 'credit_limit', message: '“lots” is not a number' },
      { line: 4, column: 'email', message: 'is empty, and the column does not take NULL' },
      { line: 4, column: 'joined_on', message: '“2024-02-30x” is not a date' }
    ])
  })

  it('reads the first record as values when there is no header', () => {
    const plan = planImport([['x@example.com', '1']], {
      header: false,
      mapping: { email: 0, credit_limit: 1 },
      columns: importable,
      emptyAs: 'null'
    })
    expect(plan.rows).toEqual([{ line: 1, values: { email: 'x@example.com', credit_limit: '1' } }])
  })
})
