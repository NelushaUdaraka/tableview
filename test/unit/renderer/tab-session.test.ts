/**
 * Open tabs across a restart: what a window saves of them, and how they come
 * back — in their panes, in order, with the same one showing.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeSavedTabs } from '../../../src/shared/uiState'
import { useTabStore, type QueryTab, type TableTab } from '../../../src/renderer/src/stores/tabs'

beforeEach(() => setActivePinia(createPinia()))

const routine = {
  schema: 'dbo',
  name: 'usp_orders',
  baseline: 'CREATE OR ALTER PROCEDURE dbo.usp_orders AS SELECT 1'
}

/** A window's tabs, saved, and reopened in a window of their own. */
function reopened(saved: ReturnType<ReturnType<typeof useTabStore>['snapshot']>) {
  setActivePinia(createPinia())
  const tabs = useTabStore()
  // Through the file's own reading, as a restart would take it.
  expect(tabs.restore('c1', normalizeSavedTabs(JSON.parse(JSON.stringify(saved)))!)).toBe(true)
  return tabs
}

describe('saving and restoring open tabs', () => {
  it('saves nothing for a connection with no tabs', async () => {
    const tabs = useTabStore()
    expect(tabs.snapshot('c1')).toBeNull()
    await tabs.openQuery('c2', 'SELECT 2')
    expect(tabs.snapshot('c1')).toBeNull()
  })

  it('brings back tabs in their order, with their text, views and the one showing', async () => {
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1', 'Scratch')
    await tabs.openTable('c1', 'sales', 'orders', 'table', 'structure')
    await tabs.openTable('c1', 'dbo', 'v_totals', 'view')
    const query = tabs.tabs[0] as QueryTab
    tabs.update<QueryTab>(query.id, { cursor: 3, dirty: true, savedQueryId: 'q1' })
    tabs.update<TableTab>(tabs.tabs[2].id, { hiddenColumns: ['notes'] })
    await tabs.select(tabs.tabs[1].id)

    const back = reopened(tabs.snapshot('c1'))
    expect(back.tabs.map((tab) => tab.title)).toEqual(['Scratch', 'orders', 'v_totals'])
    expect(back.tabs.every((tab) => tab.connectionId === 'c1')).toBe(true)
    const [q, orders, totals] = back.tabs as [QueryTab, TableTab, TableTab]
    expect(q).toMatchObject({ sql: 'SELECT 1', cursor: 3, dirty: true, savedQueryId: 'q1', result: null })
    expect(orders).toMatchObject({ schema: 'sales', table: 'orders', view: 'structure', pendingEdits: 0 })
    expect(totals).toMatchObject({ objectType: 'view', view: 'data', hiddenColumns: ['notes'] })
    expect(back.activeId).toBe(orders.id)
  })

  it('brings back a split, and the pane that had the focus', async () => {
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    await tabs.openTable('c1', 'dbo', 'customers')
    await tabs.openTable('c1', 'dbo', 'orders')
    await tabs.splitTab(tabs.tabs[2].id)
    tabs.focusPane(tabs.panes[0].id)

    const back = reopened(tabs.snapshot('c1'))
    expect(back.panes).toHaveLength(2)
    expect(back.tabsIn(back.panes[0].id).map((tab) => tab.title)).toEqual(['Query', 'customers'])
    expect(back.tabsIn(back.panes[1].id).map((tab) => tab.title)).toEqual(['orders'])
    expect(back.focusedPaneId).toBe(back.panes[0].id)
    expect(back.activeIdIn(back.panes[0].id)).toBe(back.tabsIn(back.panes[0].id)[1].id)
  })

  it('reopens a routine at its stored definition, without the changes the quit discarded', async () => {
    const tabs = useTabStore()
    await tabs.openRoutine('c1', routine)
    tabs.update<QueryTab>(tabs.tabs[0].id, { sql: routine.baseline + '\n-- unsaved', changeCount: 1 })

    const back = reopened(tabs.snapshot('c1'))
    const tab = back.tabs[0] as QueryTab
    expect(tab.sql).toBe(routine.baseline)
    expect(tab.routine).toMatchObject({ schema: 'dbo', name: 'usp_orders' })
    expect(back.hasUnsavedWork).toBe(false)
  })

  it('does not restore over tabs a window already has', async () => {
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    const saved = tabs.snapshot('c1')!
    expect(tabs.restore('c1', saved)).toBe(false)
    expect(tabs.tabs).toHaveLength(1)
  })
})
