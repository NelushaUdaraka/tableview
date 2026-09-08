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
  it('applies a patch that changes something', () => {
    const tabs = useTabStore()
    const tab = tabs.openQuery('c1', 'SELECT 1')
    tabs.update<QueryTab>(tab.id, { statementLine: 3, dirty: true })

    const updated = tabs.tabs[0] as QueryTab
    expect(updated.statementLine).toBe(3)
    expect(updated.dirty).toBe(true)
    expect(updated.sql).toBe('SELECT 1')
  })

  it('leaves the tab object untouched when the patch changes nothing', () => {
    const tabs = useTabStore()
    const tab = tabs.openQuery('c1', 'SELECT 1')
    const before = tabs.tabs[0]

    tabs.update<QueryTab>(tab.id, { statementLine: null, running: false })
    // Same object, so nothing computed from it is invalidated.
    expect(tabs.tabs[0]).toBe(before)

    tabs.update<QueryTab>(tab.id, { statementLine: 2 })
    expect(tabs.tabs[0]).not.toBe(before)
  })

  it('ignores a patch for a tab that is gone', () => {
    const tabs = useTabStore()
    tabs.openQuery('c1', 'SELECT 1')
    expect(() => tabs.update<QueryTab>('tab-does-not-exist', { dirty: true })).not.toThrow()
  })

  /**
   * The shape that froze the query view: a computed rebuilding an object from
   * the tab, and a watcher pushing part of it back into the store.
   */
  it('settles a watcher that writes back a value it derived from the tab', async () => {
    const tabs = useTabStore()
    const tab = tabs.openQuery('c1', 'SELECT 1')

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
