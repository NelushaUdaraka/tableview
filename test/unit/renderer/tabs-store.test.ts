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
import { useSettingsStore } from '../../../src/renderer/src/stores/settings'
import { useTabStore, type QueryTab, type TableTab } from '../../../src/renderer/src/stores/tabs'
import type { TableCache } from '../../../src/renderer/src/lib/tableCache'

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
 * The row panel belongs to the tab showing it, not to the window: a split is
 * two things being compared, and spelling one of them out field by field says
 * nothing about the other.
 */
describe('the row panel', () => {
  it('opens a tab the way the setting says', async () => {
    const tabs = useTabStore()
    const settings = useSettingsStore()

    await tabs.openQuery('c1', 'SELECT 1')
    expect((tabs.tabs[0] as QueryTab).showRowPanel).toBe(settings.settings.showRowPanel)

    settings.settings.showRowPanel = false
    await tabs.openTable('c1', 'dbo', 'customers')
    expect((tabs.tabs[1] as TableTab).showRowPanel).toBe(false)
    // The tab that was already open keeps its own answer.
    expect((tabs.tabs[0] as QueryTab).showRowPanel).toBe(true)
  })

  it('is answered by one tab without answering for the other', async () => {
    const tabs = useTabStore()
    await tabs.openTable('c1', 'dbo', 'customers')
    await tabs.openTable('c1', 'dbo', 'orders')
    const [first, second] = tabs.tabs.map((tab) => tab.id)

    await tabs.splitTab(second)
    tabs.update<TableTab>(second, { showRowPanel: false })

    expect((tabs.tabs.find((tab) => tab.id === first) as TableTab).showRowPanel).toBe(true)
    expect((tabs.tabs.find((tab) => tab.id === second) as TableTab).showRowPanel).toBe(false)
  })

  it('gives a second view of a tab the same starting answer', async () => {
    const tabs = useTabStore()
    await tabs.openTable('c1', 'dbo', 'customers')
    const only = tabs.activeId!
    tabs.update<TableTab>(only, { showRowPanel: false })

    await tabs.splitTab(only)
    const copy = tabs.activeIdIn(tabs.panes[1].id)!

    expect((tabs.tabs.find((tab) => tab.id === copy) as TableTab).showRowPanel).toBe(false)
    // ...and from there the two are independent.
    tabs.update<TableTab>(copy, { showRowPanel: true })
    expect((tabs.tabs.find((tab) => tab.id === only) as TableTab).showRowPanel).toBe(false)
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

  it('drops a tab into the gap the pointer is over, not one past it', async () => {
    const tabs = await threeTabs()
    const [first, second, third] = tabs.tabs.map((tab) => tab.id)

    // The strip reads [first, second, third]; dragging the first tab into the
    // gap before the third means landing between second and third. The index
    // counts gaps in the strip as drawn, so it still counts the dragged tab.
    tabs.reorder(first, 2)
    expect(tabs.tabsIn(tabs.panes[0].id).map((tab) => tab.id)).toEqual([second, first, third])

    // Dragging backwards needs no such correction.
    tabs.reorder(third, 0)
    expect(tabs.tabsIn(tabs.panes[0].id).map((tab) => tab.id)).toEqual([third, second, first])

    // Past the last gap the tab goes to the end.
    tabs.reorder(third, 3)
    expect(tabs.tabsIn(tabs.panes[0].id).map((tab) => tab.id)).toEqual([second, first, third])
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

/**
 * Only a pane's active tab is mounted, so a tab that is not showing has no
 * view to hold anything. The page it last had lives on the tab instead, which
 * is what lets the browser draw it again before it has asked the server
 * anything.
 */
describe('a tab\'s cached page', () => {
  function page(over: Partial<TableCache> = {}): TableCache {
    return {
      columns: [
        {
          name: 'id',
          index: 0,
          dataType: 'int',
          jsKind: 'number',
          nullable: false,
          isIdentity: true,
          isReadOnly: false
        }
      ],
      rows: [[1], [2]],
      totalRows: 2,
      offset: 0,
      pageSize: 100,
      sorts: [{ column: 'id', direction: 'asc' }],
      filters: [],
      filterMode: 'builder',
      rawWhere: '',
      showFilters: false,
      durationMs: 12,
      sql: 'SELECT * FROM [dbo].[customers]',
      scrollTop: 240,
      filterRevision: 0,
      ...over
    }
  }

  it('is still there when the tab is picked again', async () => {
    const tabs = useTabStore()
    await tabs.openTable('c1', 'dbo', 'customers')
    const customers = tabs.activeId!
    tabs.update<TableTab>(customers, { cache: page() })

    await tabs.openTable('c1', 'dbo', 'orders')
    await tabs.select(customers)

    const cache = (tabs.tabs.find((tab) => tab.id === customers) as TableTab).cache
    expect(cache?.rows).toEqual([[1], [2]])
    expect(cache?.scrollTop).toBe(240)
    expect(cache?.sorts).toEqual([{ column: 'id', direction: 'asc' }])
  })

  it('goes with the tab when it closes', async () => {
    const tabs = useTabStore()
    await tabs.openTable('c1', 'dbo', 'customers')
    const customers = tabs.activeId!
    tabs.update<TableTab>(customers, { cache: page() })

    await tabs.close(customers)
    expect(tabs.tabs).toHaveLength(0)
  })

  /**
   * A query tab's result cannot come along — nobody ran it in the new tab —
   * but a table tab loads the moment it opens, so the copy is about to ask for
   * those very rows and may as well show them while it waits.
   */
  it('comes along when a lone tab is split into a second view', async () => {
    const tabs = useTabStore()
    await tabs.openTable('c1', 'dbo', 'customers')
    const customers = tabs.activeId!
    tabs.update<TableTab>(customers, { cache: page(), pendingEdits: 3 })

    await tabs.splitTab(customers)

    const copy = tabs.tabs.find((tab) => tab.id !== customers) as TableTab
    expect(copy.table).toBe('customers')
    expect(copy.cache?.rows).toEqual([[1], [2]])
    // The staged edits do not: they belong to the view that is holding them.
    expect(copy.pendingEdits).toBe(0)
  })
})

/**
 * A routine opened from the tree is its definition, in a query tab that knows
 * which routine it is and what is stored for it — which is what the editor
 * marks changes against.
 */
describe('a routine\'s tab', () => {
  const routine = {
    schema: 'dbo',
    name: 'usp_orders',
    type: 'procedure' as const,
    database: 'Sales',
    baseline: 'CREATE OR ALTER PROCEDURE dbo.usp_orders AS\r\nSELECT 1'
  }

  it('opens holding the definition, titled by the routine', async () => {
    const tabs = useTabStore()
    await tabs.openRoutine('c1', routine)

    const tab = tabs.tabs[0] as QueryTab
    expect(tab.title).toBe('usp_orders')
    expect(tab.sql).toBe(routine.baseline)
    expect(tab.routine).toEqual(routine)
    expect(tab.changeCount).toBe(0)
    expect(tab.dirty).toBe(false)
  })

  it('keeps its own copy of what it was given', async () => {
    const tabs = useTabStore()
    const given = { ...routine }
    await tabs.openRoutine('c1', given)
    given.baseline = 'changed afterwards'
    expect((tabs.tabs[0] as QueryTab).routine?.baseline).toBe(routine.baseline)
  })

  it('shows the tab that already has the routine rather than opening another', async () => {
    const tabs = useTabStore()
    await tabs.openRoutine('c1', routine)
    const first = tabs.activeId
    await tabs.openQuery('c1', 'SELECT 2')

    await tabs.openRoutine('c1', { ...routine, baseline: 'read again' })

    expect(tabs.tabs).toHaveLength(2)
    expect(tabs.activeId).toBe(first)
    // The tab is left as it was: its edits and its baseline are its own.
    expect((tabs.tabs[0] as QueryTab).routine?.baseline).toBe(routine.baseline)
  })

  it('is found by routine and database, on its own connection', async () => {
    const tabs = useTabStore()
    await tabs.openRoutine('c1', routine)

    expect(tabs.routineTab('c1', routine)?.id).toBe(tabs.tabs[0].id)
    // The same name in another database is another routine.
    expect(tabs.routineTab('c1', { ...routine, database: 'Archive' })).toBeUndefined()
    expect(tabs.routineTab('c2', routine)).toBeUndefined()
    expect(tabs.routineTab('c1', { ...routine, name: 'usp_other' })).toBeUndefined()
  })

  it('opens beside the one already open when it arrives with edits of its own', async () => {
    const tabs = useTabStore()
    await tabs.openRoutine('c1', routine)

    // Dragged in from another window: its text exists nowhere else.
    await tabs.openRoutine('c1', routine, { sql: 'CREATE OR ALTER PROCEDURE dbo.usp_orders AS SELECT 2' })
    expect(tabs.tabs).toHaveLength(2)
    expect((tabs.tabs[1] as QueryTab).sql).toContain('SELECT 2')
    expect((tabs.tabs[1] as QueryTab).routine?.baseline).toBe(routine.baseline)

    // The same text again is nothing new.
    await tabs.openRoutine('c1', routine, { sql: routine.baseline })
    expect(tabs.tabs).toHaveLength(2)
  })

  it('is never taken for a blank query tab to reuse', async () => {
    const tabs = useTabStore()
    await tabs.openRoutine('c1', { ...routine, baseline: '' })
    await tabs.openQuery('c1')
    expect(tabs.tabs).toHaveLength(2)
  })

  it('gives a second view the same routine and baseline', async () => {
    const tabs = useTabStore()
    await tabs.openRoutine('c1', routine)
    await tabs.splitTab(tabs.activeId!)

    const copy = tabs.tabs[1] as QueryTab
    expect(copy.routine).toEqual(routine)
  })

  it('moves the baseline of every tab on the routine once one of them saves it', async () => {
    const tabs = useTabStore()
    await tabs.openRoutine('c1', routine)
    await tabs.splitTab(tabs.activeId!)
    await tabs.openRoutine('c1', { ...routine, name: 'usp_other' })
    await tabs.openRoutine('c1', { ...routine, database: 'Archive' })

    tabs.storeRoutine('c1', routine, 'CREATE OR ALTER PROCEDURE dbo.usp_orders AS SELECT 2')

    const baselines = (tabs.tabs as QueryTab[]).map((tab) => tab.routine?.baseline)
    expect(baselines).toEqual([
      'CREATE OR ALTER PROCEDURE dbo.usp_orders AS SELECT 2',
      'CREATE OR ALTER PROCEDURE dbo.usp_orders AS SELECT 2',
      // Another routine, and the same name in another database, are untouched.
      routine.baseline,
      routine.baseline
    ])
  })
})
