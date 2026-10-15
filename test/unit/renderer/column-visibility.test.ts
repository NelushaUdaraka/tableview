/**
 * A table tab keeps the names of the columns taken out of its grid. These are
 * the sums over that list: what the grid draws, what the picker lists for a
 * search, and the list after a column goes or comes back.
 */
import { describe, expect, it } from 'vitest'
import {
  hiddenColumnIndexes,
  hideColumns,
  matchColumns,
  pickColumns,
  setColumnShown,
  showColumns,
  shownColumnIndexes
} from '../../../src/renderer/src/lib/columnVisibility'

const columns = [
  { name: 'customer_id' },
  { name: 'email' },
  { name: 'display_name' },
  { name: 'Created_At' },
  { name: 'notes' }
]

describe('which columns are drawn', () => {
  it('draws every column when none is hidden', () => {
    expect(shownColumnIndexes(columns, [])).toEqual([0, 1, 2, 3, 4])
    expect(hiddenColumnIndexes(columns, [])).toEqual([])
  })

  it('leaves the hidden ones out, keeping the rest in table order', () => {
    expect(shownColumnIndexes(columns, ['notes', 'email'])).toEqual([0, 2, 3])
    expect(hiddenColumnIndexes(columns, ['notes', 'email'])).toEqual([1, 4])
  })

  it('goes by the exact name', () => {
    expect(shownColumnIndexes(columns, ['created_at'])).toEqual([0, 1, 2, 3, 4])
    expect(shownColumnIndexes(columns, ['Created_At'])).toEqual([0, 1, 2, 4])
  })

  it('hides nothing for a name the table no longer has', () => {
    expect(shownColumnIndexes(columns, ['dropped_column'])).toEqual([0, 1, 2, 3, 4])
    expect(hiddenColumnIndexes(columns, ['dropped_column'])).toEqual([])
  })

  it('can leave nothing to draw', () => {
    const all = columns.map((column) => column.name)
    expect(shownColumnIndexes(columns, all)).toEqual([])
  })
})

describe('changing what is hidden', () => {
  it('hides a column once, however often it is asked', () => {
    expect(hideColumns([], ['email'])).toEqual(['email'])
    expect(hideColumns(['email'], ['email', 'notes'])).toEqual(['email', 'notes'])
  })

  it('puts columns back', () => {
    expect(showColumns(['email', 'notes', 'display_name'], ['notes', 'email'])).toEqual([
      'display_name'
    ])
    expect(showColumns(['email'], ['notes'])).toEqual(['email'])
  })

  it('flips one column either way', () => {
    expect(setColumnShown([], 'email', false)).toEqual(['email'])
    expect(setColumnShown(['email', 'notes'], 'email', true)).toEqual(['notes'])
    expect(setColumnShown(['notes'], 'email', true)).toEqual(['notes'])
  })

  it('never changes the list it was given', () => {
    const hidden = ['email']
    hideColumns(hidden, ['notes'])
    showColumns(hidden, ['email'])
    setColumnShown(hidden, 'notes', false)
    expect(hidden).toEqual(['email'])
  })
})

describe('finding a column', () => {
  it('lists every column for an empty search', () => {
    expect(matchColumns(columns, '')).toEqual(columns)
    expect(matchColumns(columns, '   ')).toEqual(columns)
  })

  it('matches anywhere in the name, whatever the case', () => {
    expect(matchColumns(columns, 'AT').map((column) => column.name)).toEqual(['Created_At'])
    expect(matchColumns(columns, ' name ').map((column) => column.name)).toEqual(['display_name'])
    expect(matchColumns(columns, '_').map((column) => column.name)).toEqual([
      'customer_id',
      'display_name',
      'Created_At'
    ])
  })

  it('lists nothing when nothing matches', () => {
    expect(matchColumns(columns, 'zzz')).toEqual([])
  })
})

describe('the page as the grid shows it', () => {
  const names = ['id', 'email', 'notes']
  const rows = [
    [1, 'ada@example.com', 'first'],
    [2, 'alan@example.com', null]
  ]

  it('keeps only the columns on show, in their order, row by row', () => {
    expect(pickColumns(names, rows, [0, 2])).toEqual({
      columns: ['id', 'notes'],
      rows: [
        [1, 'first'],
        [2, null]
      ]
    })
  })

  it('hands the page back untouched when nothing is hidden', () => {
    const page = pickColumns(names, rows, [0, 1, 2])
    expect(page.columns).toBe(names)
    expect(page.rows).toBe(rows)
  })

  it('leaves no columns, and empty rows, when everything is hidden', () => {
    expect(pickColumns(names, rows, [])).toEqual({ columns: [], rows: [[], []] })
  })
})
