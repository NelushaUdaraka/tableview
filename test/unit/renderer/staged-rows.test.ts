/**
 * Removing a staged insert from the middle of the list renumbers every one
 * after it. The values are keyed by that number, so this is the difference
 * between deleting a row and quietly moving another row's values onto it.
 */
import { describe, expect, it } from 'vitest'
import { reindexStagedEdits, rowIndexOf } from '../../../src/renderer/src/lib/stagedRows'

// Three stored rows, then three staged inserts at 3, 4 and 5.
const LOADED = 3
const edits = {
  '1:0': 'stored row edit',
  '3:0': 'first staged',
  '3:1': 'first staged b',
  '4:0': 'second staged',
  '5:0': 'third staged'
}

describe('reindexStagedEdits', () => {
  it('leaves everything alone when nothing was removed', () => {
    expect(reindexStagedEdits(edits, LOADED, [0, 1, 2])).toEqual(edits)
  })

  it('moves the rows after a removed one down onto its number', () => {
    // The middle staged row goes; the third becomes the second.
    expect(reindexStagedEdits(edits, LOADED, [0, 2])).toEqual({
      '1:0': 'stored row edit',
      '3:0': 'first staged',
      '3:1': 'first staged b',
      '4:0': 'third staged'
    })
  })

  it('renumbers from the top when the first is removed', () => {
    expect(reindexStagedEdits(edits, LOADED, [1, 2])).toEqual({
      '1:0': 'stored row edit',
      '3:0': 'second staged',
      '4:0': 'third staged'
    })
  })

  it('keeps stored rows out of it', () => {
    const result = reindexStagedEdits(edits, LOADED, [])
    expect(result).toEqual({ '1:0': 'stored row edit' })
  })

  it('carries every column of a row that moves', () => {
    const result = reindexStagedEdits(edits, LOADED, [0])
    expect(result['3:0']).toBe('first staged')
    expect(result['3:1']).toBe('first staged b')
  })

  it('reads the row out of a key', () => {
    expect(rowIndexOf('12:3')).toBe(12)
    expect(rowIndexOf('0:0')).toBe(0)
  })
})
