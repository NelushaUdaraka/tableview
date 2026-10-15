/**
 * Whether a table read goes through a filter decides whether *Clear filters*
 * has rows to re-read, so it has to agree with what the main process actually
 * sends: the raw WHERE only in raw mode and only with text in it, the
 * builder's rows otherwise.
 */
import { describe, expect, it } from 'vitest'
import { readsFiltered } from '../../../src/renderer/src/lib/tableFilters'
import type { TableFilter } from '../../../src/shared/types'

const row: TableFilter = { column: 'status', operator: '=', value: 'new', conjunction: 'AND' }

describe('readsFiltered', () => {
  it('reads unfiltered with nothing in the bar', () => {
    expect(readsFiltered({ filters: [], filterMode: 'builder', rawWhere: '' })).toBe(false)
    expect(readsFiltered({ filters: [], filterMode: 'raw', rawWhere: '' })).toBe(false)
  })

  it('reads through the builder’s rows in builder mode', () => {
    expect(readsFiltered({ filters: [row], filterMode: 'builder', rawWhere: '' })).toBe(true)
  })

  it('ignores a raw WHERE left behind in builder mode', () => {
    expect(readsFiltered({ filters: [], filterMode: 'builder', rawWhere: 'id > 3' })).toBe(false)
  })

  it('reads through the raw WHERE in raw mode', () => {
    expect(readsFiltered({ filters: [], filterMode: 'raw', rawWhere: 'id > 3' })).toBe(true)
  })

  it('falls back to the builder’s rows when the raw box is blank', () => {
    expect(readsFiltered({ filters: [row], filterMode: 'raw', rawWhere: '   ' })).toBe(true)
    expect(readsFiltered({ filters: [], filterMode: 'raw', rawWhere: '  \n ' })).toBe(false)
  })
})
