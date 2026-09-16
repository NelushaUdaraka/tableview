/**
 * Naming a duplicated connection.
 *
 * The name is the only thing separating a copy from what it was copied from in
 * the list, so it has to be both distinct and readable after the third pass.
 */
import { describe, expect, it } from 'vitest'
import { copyNameFor, copyStem } from '../../src/shared/copyName'

describe('the stem a copy is named from', () => {
  it('leaves a name that copies nothing alone', () => {
    expect(copyStem('Prod')).toBe('Prod')
    expect(copyStem('  Prod EU  ')).toBe('Prod EU')
  })

  it('strips a copy suffix, numbered or not, however it was typed', () => {
    expect(copyStem('Prod (copy)')).toBe('Prod')
    expect(copyStem('Prod (copy 2)')).toBe('Prod')
    expect(copyStem('Prod (Copy 17)')).toBe('Prod')
    expect(copyStem('Prod (COPY)')).toBe('Prod')
  })

  it('only strips the suffix at the end', () => {
    expect(copyStem('Prod (copy) EU')).toBe('Prod (copy) EU')
  })

  it('keeps a connection actually called "(copy)" from becoming nameless', () => {
    expect(copyStem('(copy)')).toBe('(copy)')
  })
})

describe('the name the copy gets', () => {
  it('appends (copy) when nothing is in the way', () => {
    expect(copyNameFor('Prod', ['Prod'])).toBe('Prod (copy)')
  })

  it('numbers from the stem rather than stacking suffixes', () => {
    // Duplicating the copy gives a sibling, not "Prod (copy) (copy)".
    expect(copyNameFor('Prod (copy)', ['Prod', 'Prod (copy)'])).toBe('Prod (copy 2)')
    expect(copyNameFor('Prod (copy 2)', ['Prod', 'Prod (copy)', 'Prod (copy 2)'])).toBe(
      'Prod (copy 3)'
    )
  })

  it('walks up to the first free number', () => {
    const taken = ['Prod', 'Prod (copy)', 'Prod (copy 2)', 'Prod (copy 4)']
    expect(copyNameFor('Prod', taken)).toBe('Prod (copy 3)')
  })

  it('treats names that differ only in case or spacing as taken', () => {
    expect(copyNameFor('Prod', ['prod (COPY)', '  Prod (copy 2)  '])).toBe('Prod (copy 3)')
  })

  it('needs no list to work from', () => {
    expect(copyNameFor('Prod')).toBe('Prod (copy)')
  })

  it('does not lead with a space when the source has no name', () => {
    expect(copyNameFor('', [])).toBe('(copy)')
  })
})
