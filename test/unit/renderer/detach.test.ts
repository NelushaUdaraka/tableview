/**
 * A tab dragged into a window of its own is described, not moved.
 *
 * Windows share no connection pool and no tab state, so anything that belongs
 * to the window a tab came from — staged edits, a result set, a cursor — must
 * not travel with it; what crosses is only enough to open the same thing again.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { detachedTabFrom, openTabFrom } from '../../../src/renderer/src/lib/detach'
import { useTabStore, type QueryTab, type TableTab } from '../../../src/renderer/src/stores/tabs'

const tableTab: TableTab = {
  id: 'tab-1',
  kind: 'table',
  title: 'customers',
  connectionId: 'c1',
  schema: 'dbo',
  table: 'customers',
  objectType: 'view',
  view: 'structure',
  pendingEdits: 3,
  filters: [{ column: 'id', operator: '=', value: '7' }],
  filterRevision: 2,
  showRowPanel: true
}

const queryTab: QueryTab = {
  id: 'tab-2',
  kind: 'query',
  title: 'Monthly totals',
  connectionId: 'c1',
  sql: 'SELECT 1',
  cursor: 8,
  result: null,
  running: true,
  executionId: 'exec-1',
  activeResultIndex: 1,
  dirty: true,
  statementLine: 1,
  showRowPanel: false
}

describe('detachedTabFrom', () => {
  it('carries what it takes to reopen a table', () => {
    expect(detachedTabFrom(tableTab)).toEqual({
      kind: 'table',
      connectionId: 'c1',
      title: 'customers',
      schema: 'dbo',
      table: 'customers',
      objectType: 'view',
      view: 'structure'
    })
  })

  it('carries the SQL of a query, and not the run it was in the middle of', () => {
    const payload = detachedTabFrom(queryTab)
    expect(payload).toEqual({
      kind: 'query',
      connectionId: 'c1',
      title: 'Monthly totals',
      sql: 'SELECT 1'
    })
    expect(payload).not.toHaveProperty('executionId')
    expect(payload).not.toHaveProperty('running')
  })

  it('leaves the old window\'s state behind', () => {
    const payload = detachedTabFrom(tableTab) as unknown as Record<string, unknown>
    // Staged edits belong to the view that is about to be unmounted; a tab that
    // carried a count of them would open claiming edits it does not have.
    expect(payload.pendingEdits).toBeUndefined()
    expect(payload.filters).toBeUndefined()
    expect(payload.id).toBeUndefined()
  })
})

describe('detachedTabFrom, for a routine\'s tab', () => {
  it('carries the routine and what is stored for it, so its changes are still marked', () => {
    const routine = { schema: 'dbo', name: 'usp_orders', database: 'Sales', baseline: 'CREATE …' }
    const payload = detachedTabFrom({ ...queryTab, sql: 'CREATE … edited', routine, changeCount: 2 })
    expect(payload).toEqual({
      kind: 'query',
      connectionId: 'c1',
      title: 'Monthly totals',
      sql: 'CREATE … edited',
      routine
    })
    // A copy, not the tab's own object.
    expect(payload.routine).not.toBe(routine)
  })

  it('carries no routine for a plain query', () => {
    expect(detachedTabFrom(queryTab)).not.toHaveProperty('routine')
  })
})

/**
 * The other half: a description opened in the window it lands in — or in the
 * one it came from, when no window took it.
 */
describe('openTabFrom', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('reopens a table in the view it was showing', async () => {
    await openTabFrom(detachedTabFrom(tableTab))
    const tabs = useTabStore()
    const opened = tabs.tabs[0] as TableTab
    expect(opened).toMatchObject({
      kind: 'table',
      schema: 'dbo',
      table: 'customers',
      objectType: 'view',
      view: 'structure'
    })
    // Nothing of the old window's comes with it.
    expect(opened.pendingEdits).toBe(0)
    expect(opened.filters).toBeUndefined()
  })

  it('reopens a routine with its edits, its changes marked against what is stored', async () => {
    const routine = { schema: 'dbo', name: 'usp_orders', baseline: 'CREATE … stored' }
    await openTabFrom(detachedTabFrom({ ...queryTab, sql: 'CREATE … edited', routine }))
    const opened = useTabStore().tabs[0] as QueryTab
    expect(opened.sql).toBe('CREATE … edited')
    expect(opened.routine).toEqual(routine)
    expect(opened.title).toBe('usp_orders')
  })

  it('reopens a plain query with its title and text', async () => {
    await openTabFrom(detachedTabFrom(queryTab))
    const opened = useTabStore().tabs[0] as QueryTab
    expect(opened).toMatchObject({ kind: 'query', title: 'Monthly totals', sql: 'SELECT 1' })
    expect(opened.routine).toBeUndefined()
  })
})
