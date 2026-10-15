/**
 * The header menu is built from what the grid can actually do, so the entries
 * on it are never a lie: a result set has no query to re-filter, and "clear"
 * only offers itself when there is something to clear.
 */
import { describe, expect, it } from 'vitest'
import { columnMenuItems } from '../../../src/renderer/src/lib/columnMenu'

const base = {
  column: 'status',
  direction: null as 'asc' | 'desc' | null,
  anySort: false,
  filterable: true,
  filtered: false
}

const actions = (items: ReturnType<typeof columnMenuItems>): string[] =>
  items.filter((item) => !item.separator).map((item) => item.action ?? '')

describe('columnMenuItems', () => {
  it('offers both directions and the column name', () => {
    const items = columnMenuItems(base)
    expect(actions(items)).toContain('sort-asc')
    expect(actions(items)).toContain('sort-desc')
    expect(items.some((item) => item.label.includes('status'))).toBe(true)
  })

  it('marks the direction the column is already sorted in', () => {
    const items = columnMenuItems({ ...base, direction: 'desc', anySort: true })
    expect(items.find((item) => item.action === 'sort-desc')?.hint).toBe('✓')
    expect(items.find((item) => item.action === 'sort-asc')?.hint).toBeUndefined()
  })

  it('offers adding to the sort only for a column outside it', () => {
    expect(actions(columnMenuItems({ ...base, anySort: true }))).toContain('sort-add')
    expect(actions(columnMenuItems({ ...base, anySort: true, direction: 'asc' }))).not.toContain(
      'sort-add'
    )
    expect(actions(columnMenuItems(base))).not.toContain('sort-add')
  })

  it('disables clearing when there is nothing to clear', () => {
    const idle = columnMenuItems(base)
    expect(idle.find((item) => item.action === 'sort-clear')?.disabled).toBe(true)
    expect(idle.find((item) => item.action === 'filter-clear')?.disabled).toBe(true)

    const busy = columnMenuItems({ ...base, anySort: true, filtered: true })
    expect(busy.find((item) => item.action === 'sort-clear')?.disabled).toBe(false)
    expect(busy.find((item) => item.action === 'filter-clear')?.disabled).toBe(false)
  })

  it('leaves filtering out of a grid that cannot filter', () => {
    const items = actions(columnMenuItems({ ...base, filterable: false }))
    expect(items.some((action) => action.startsWith('filter-'))).toBe(false)
    // Sorting and the width entries are still there.
    expect(items).toContain('sort-asc')
    expect(items).toContain('fit-all')
  })

  it('offers hiding only where the grid can hide a column', () => {
    expect(actions(columnMenuItems(base))).not.toContain('hide-column')
    expect(actions(columnMenuItems(base))).not.toContain('show-all-columns')

    const items = columnMenuItems({ ...base, hideable: true })
    expect(actions(items)).toContain('hide-column')
    // Nothing is hidden yet, so putting everything back would do nothing.
    expect(items.find((item) => item.action === 'show-all-columns')?.disabled).toBe(true)
    expect(
      columnMenuItems({ ...base, hideable: true, anyHidden: true }).find(
        (item) => item.action === 'show-all-columns'
      )?.disabled
    ).toBe(false)
  })

  it('gives every entry something to do', () => {
    for (const item of columnMenuItems({ ...base, anySort: true, hideable: true })) {
      if (item.separator) continue
      expect(item.action, item.label).toBeTruthy()
      expect(item.label).toBeTruthy()
    }
  })
})
