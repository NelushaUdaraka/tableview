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
 * Only a pane's active tab is mounted, so only those can be holding staged
 * work — and every way of unmounting one goes through here. Guards are keyed
 * by tab because a split workspace has a mounted view per pane.
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
    const table = tabs.activeId!
    const query = tabs.tabs[0].id

    tabs.setLeaveGuard(table, async () => false)
    await tabs.select(query)
    expect(tabs.activeId).toBe(table)

    tabs.setLeaveGuard(table, async () => true)
    await tabs.select(query)
    expect(tabs.activeId).toBe(query)
  })

  it('asks before opening another table over it', async () => {
    const tabs = await twoTabs()
    tabs.setLeaveGuard(tabs.activeId!, async () => false)

    await tabs.openTable('c1', 'sales', 'orders')
    expect(tabs.tabs).toHaveLength(2)
    await tabs.openQuery('c1', 'SELECT 2')
    expect(tabs.tabs).toHaveLength(2)
  })

  it('asks before closing the tab that holds the work', async () => {
    const tabs = await twoTabs()
    const table = tabs.activeId!
    tabs.setLeaveGuard(table, async () => false)

    expect(await tabs.close(table)).toBe(false)
    expect(tabs.tabs.some((tab) => tab.id === table)).toBe(true)

    // A background tab is not the one being left, so it closes regardless.
    await tabs.close(tabs.tabs[0].id)
    expect(tabs.tabs).toHaveLength(1)
  })

  it('does not ask when the guard is cleared', async () => {
    const tabs = await twoTabs()
    const table = tabs.activeId!
    tabs.setLeaveGuard(table, async () => false)
    tabs.setLeaveGuard(table, null)

    await tabs.select(tabs.tabs[0].id)
    expect(tabs.activeId).toBe(tabs.tabs[0].id)
  })

  it('does not ask when selecting the tab that is already active', async () => {
    const tabs = await twoTabs()
    let asked = 0
    tabs.setLeaveGuard(tabs.activeId!, async () => {
      asked += 1
      return true
    })

    await tabs.select(tabs.activeId!)
    expect(asked).toBe(0)
  })

  it('asks only the tab that is being unmounted', async () => {
    const tabs = await twoTabs()
    const query = tabs.tabs[0].id
    const table = tabs.activeId!
    let askedQuery = 0

    // The query tab is in the background; closing the table must not ask it.
    tabs.setLeaveGuard(query, async () => {
      askedQuery += 1
      return true
    })
    tabs.setLeaveGuard(table, async () => true)

    await tabs.close(table)
    expect(askedQuery).toBe(0)
  })
})

/**
 * Two panes, so two tables can be read side by side. Every tab belongs to
 * exactly one pane, and a pane with nothing in it stops being a pane.
 */
describe('split view', () => {
  async function threeTabs(): Promise<ReturnType<typeof useTabStore>> {
    const tabs = useTabStore()
    await tabs.openTable('c1', 'dbo', 'customers')
    await tabs.openTable('c1', 'dbo', 'orders')
    await tabs.openTable('c1', 'dbo', 'products')
    return tabs
  }

  it('starts with one pane holding everything', async () => {
    const tabs = await threeTabs()
    expect(tabs.panes).toHaveLength(1)
    expect(tabs.tabsIn(tabs.panes[0].id)).toHaveLength(3)
    expect(tabs.isSplit).toBe(false)
  })

  it('moves the split tab into a pane of its own and shows it there', async () => {
    const tabs = await threeTabs()
    const moved = tabs.activeId!

    await tabs.splitTab(moved)

    expect(tabs.panes).toHaveLength(2)
    expect(tabs.tabsIn(tabs.panes[0].id).map((tab) => tab.id)).not.toContain(moved)
    expect(tabs.tabsIn(tabs.panes[1].id).map((tab) => tab.id)).toEqual([moved])
    // Both panes have something showing, and the new one has the focus.
    expect(tabs.activeIdIn(tabs.panes[0].id)).not.toBeNull()
    expect(tabs.activeId).toBe(moved)
  })

  it('opens a second view of a tab that is the only one in its pane', async () => {
    const tabs = useTabStore()
    await tabs.openTable('c1', 'dbo', 'customers')
    const only = tabs.activeId!

    await tabs.splitTab(only)

    expect(tabs.panes).toHaveLength(2)
    expect(tabs.tabs).toHaveLength(2)
    // A copy, not the same tab moved: the first pane keeps what it had.
    expect(tabs.activeIdIn(tabs.panes[0].id)).toBe(only)
    const copy = tabs.activeIdIn(tabs.panes[1].id)
    expect(copy).not.toBe(only)
    expect(tabs.tabs.find((tab) => tab.id === copy)).toMatchObject({
      kind: 'table',
      table: 'customers',
      pendingEdits: 0
    })
  })

  it('sends a third split to the pane that already exists', async () => {
    const tabs = await threeTabs()
    const first = tabs.tabs[0].id
    const second = tabs.tabs[1].id

    await tabs.splitTab(first)
    await tabs.splitTab(second)

    expect(tabs.panes).toHaveLength(2)
    expect(tabs.tabsIn(tabs.panes[1].id).map((tab) => tab.id)).toEqual([first, second])
  })

  it('asks both ends before a tab changes pane', async () => {
    const tabs = await threeTabs()
    const moved = tabs.tabs[0].id
    await tabs.splitTab(tabs.tabs[2].id)
    const target = tabs.panes[1].id
    const showing = tabs.activeIdIn(target)!

    // The tab showing in the destination is about to be replaced.
    tabs.setLeaveGuard(showing, async () => false)
    await tabs.moveToPane(moved, target)
    expect(tabs.tabsIn(target).map((tab) => tab.id)).toEqual([showing])

    tabs.setLeaveGuard(showing, async () => true)
    await tabs.moveToPane(moved, target, 0)
    expect(tabs.tabsIn(target).map((tab) => tab.id)).toEqual([moved, showing])
  })

  it('takes the pane away when its last tab goes', async () => {
    const tabs = await threeTabs()
    const moved = tabs.activeId!
    await tabs.splitTab(moved)

    await tabs.close(moved)

    expect(tabs.panes).toHaveLength(1)
    expect(tabs.tabs).toHaveLength(2)
    // The focus lands back on the pane that is left, with a tab showing.
    expect(tabs.activeId).toBe(tabs.activeIdIn(tabs.panes[0].id))
    expect(tabs.activeId).not.toBeNull()
  })

  it('folds the split away, keeping every tab', async () => {
    const tabs = await threeTabs()
    const moved = tabs.activeId!
    await tabs.splitTab(moved)

    await tabs.closeSplit()

    expect(tabs.panes).toHaveLength(1)
    expect(tabs.tabsIn(tabs.panes[0].id)).toHaveLength(3)
    // What was showing in the pane that went is what is showing now.
    expect(tabs.activeId).toBe(moved)
  })

  it('reorders a strip without asking anything', async () => {
    const tabs = await threeTabs()
    const [first, second, third] = tabs.tabs.map((tab) => tab.id)
    tabs.setLeaveGuard(third, async () => false)

    tabs.reorder(third, 0)

    expect(tabs.tabsIn(tabs.panes[0].id).map((tab) => tab.id)).toEqual([third, first, second])
  })

  it('cycles within the focused pane only', async () => {
    const tabs = await threeTabs()
    const moved = tabs.activeId!
    await tabs.splitTab(moved)

    // The split pane holds one tab, so cycling stays on it.
    await tabs.cycle(1)
    expect(tabs.activeId).toBe(moved)

    tabs.focusPane(tabs.panes[0].id)
    const before = tabs.activeId
    await tabs.cycle(1)
    expect(tabs.activeId).not.toBe(before)
    expect(tabs.tabsIn(tabs.panes[0].id).map((tab) => tab.id)).toContain(tabs.activeId)
  })

  it('shows a table that is already open in the pane it is in', async () => {
    const tabs = await threeTabs()
    const moved = tabs.activeId!
    await tabs.splitTab(moved)
    tabs.focusPane(tabs.panes[0].id)

    // Opening it again from the sidebar reaches for the tab that exists.
    await tabs.openTable('c1', 'dbo', 'products')

    expect(tabs.tabs).toHaveLength(3)
    expect(tabs.focusedPaneId).toBe(tabs.panes[1].id)
    expect(tabs.activeId).toBe(moved)
  })

  it('closes a connection\'s tabs across both panes', async () => {
    const tabs = await threeTabs()
    await tabs.openQuery('c2', 'SELECT 2')
    await tabs.splitTab(tabs.activeId!)

    tabs.closeForConnection('c1')

    expect(tabs.tabs.map((tab) => tab.connectionId)).toEqual(['c2'])
    expect(tabs.panes).toHaveLength(1)
  })
})
