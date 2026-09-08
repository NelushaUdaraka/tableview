/**
 * The tab store is the state every open view is derived from, so a write that
 * changes nothing still has consequences: it replaces the tab object and
 * invalidates every computed reading it. A watcher that writes back what it
 * derived then retriggers itself, and production builds carry no recursion
 * guard to stop it — the window simply locks up.
 */
import { computed, nextTick, watch } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useTabStore, type QueryTab } from '../../../src/renderer/src/stores/tabs'

beforeEach(() => setActivePinia(createPinia()))

describe('tab store updates', () => {
  it('applies a patch that changes something', async () => {
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    const tab = tabs.tabs[0] as QueryTab
    tabs.update<QueryTab>(tab.id, { statementLine: 3, dirty: true })

    const updated = tabs.tabs[0] as QueryTab
    expect(updated.statementLine).toBe(3)
    expect(updated.dirty).toBe(true)
    expect(updated.sql).toBe('SELECT 1')
  })

  it('leaves the tab object untouched when the patch changes nothing', async () => {
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    const tab = tabs.tabs[0] as QueryTab
    const before = tabs.tabs[0]

    tabs.update<QueryTab>(tab.id, { statementLine: null, running: false })
    // Same object, so nothing computed from it is invalidated.
    expect(tabs.tabs[0]).toBe(before)

    tabs.update<QueryTab>(tab.id, { statementLine: 2 })
    expect(tabs.tabs[0]).not.toBe(before)
  })

  it('ignores a patch for a tab that is gone', async () => {
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    expect(() => tabs.update<QueryTab>('tab-does-not-exist', { dirty: true })).not.toThrow()
  })

  /**
   * The shape that froze the query view: a computed rebuilding an object from
   * the tab, and a watcher pushing part of it back into the store.
   */
  it('settles a watcher that writes back a value it derived from the tab', async () => {
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    const tab = tabs.tabs[0] as QueryTab

    // A fresh object per evaluation, like `statementAt` returns.
    const derived = computed(() => ({ line: (tabs.tabs[0] as QueryTab).sql.length }))

    let runs = 0
    const stop = watch(
      derived,
      (value) => {
        runs += 1
        // Bail out rather than hang the suite if the loop is ever reopened.
        if (runs > 50) return
        tabs.update<QueryTab>(tab.id, { statementLine: value.line })
      },
      { immediate: true }
    )

    await nextTick()
    await nextTick()
    stop()

    expect(runs).toBeLessThan(5)
    expect((tabs.tabs[0] as QueryTab).statementLine).toBe('SELECT 1'.length)
  })
})

/**
 * Only the active tab is mounted, so only it can be holding staged work — and
 * every way of leaving it goes through here.
 */
describe('leaving a tab', () => {
  async function twoTabs(): Promise<ReturnType<typeof useTabStore>> {
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    await tabs.openTable('c1', 'dbo', 'customers')
    return tabs
  }

  it('asks the guard before switching away, and stays when it says no', async () => {
    const tabs = await twoTabs()
    const table = tabs.activeId
    const query = tabs.tabs[0].id

    tabs.setLeaveGuard(async () => false)
    await tabs.select(query)
    expect(tabs.activeId).toBe(table)

    tabs.setLeaveGuard(async () => true)
    await tabs.select(query)
    expect(tabs.activeId).toBe(query)
  })

  it('asks before opening another table over it', async () => {
    const tabs = await twoTabs()
    tabs.setLeaveGuard(async () => false)

    await tabs.openTable('c1', 'sales', 'orders')
    expect(tabs.tabs).toHaveLength(2)
    await tabs.openQuery('c1', 'SELECT 2')
    expect(tabs.tabs).toHaveLength(2)
  })

  it('asks before closing the tab that holds the work', async () => {
    const tabs = await twoTabs()
    const table = tabs.activeId!
    tabs.setLeaveGuard(async () => false)

    await tabs.close(table)
    expect(tabs.tabs.some((tab) => tab.id === table)).toBe(true)

    // A background tab is not the one being left, so it closes regardless.
    await tabs.close(tabs.tabs[0].id)
    expect(tabs.tabs).toHaveLength(1)
  })

  it('does not ask when the guard is cleared', async () => {
    const tabs = await twoTabs()
    tabs.setLeaveGuard(async () => false)
    tabs.setLeaveGuard(null)

    await tabs.select(tabs.tabs[0].id)
    expect(tabs.activeId).toBe(tabs.tabs[0].id)
  })

  it('does not ask when selecting the tab that is already active', async () => {
    const tabs = await twoTabs()
    let asked = 0
    tabs.setLeaveGuard(async () => {
      asked += 1
      return true
    })

    await tabs.select(tabs.activeId!)
    expect(asked).toBe(0)
  })
})
