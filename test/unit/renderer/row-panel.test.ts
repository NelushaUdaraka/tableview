/**
 * The row panel belongs to the tab showing it.
 *
 * It used to be an app setting, which made it an app-wide answer: two tables
 * side by side in a split are there to be compared, and hiding one's fields
 * hid the other's with it. What is left of the setting is how the next tab
 * opens.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRowPanel } from '../../../src/renderer/src/lib/rowPanel'
import { useSettingsStore } from '../../../src/renderer/src/stores/settings'
import { useTabStore, type Tab } from '../../../src/renderer/src/stores/tabs'

beforeEach(() => {
  setActivePinia(createPinia())
  // The setting is written through the main process; what it is written to
  // matters here, not that it got there.
  vi.spyOn(useSettingsStore(), 'update').mockImplementation(async (patch) => {
    Object.assign(useSettingsStore().settings, patch)
  })
})

async function twoTables(): Promise<{ first: Tab; second: Tab }> {
  const tabs = useTabStore()
  await tabs.openTable('c1', 'dbo', 'customers')
  await tabs.openTable('c1', 'dbo', 'orders')
  return { first: tabs.tabs[0], second: tabs.tabs[1] }
}

/** Reads the tab back out of the store: every write replaces the object. */
function current(id: string): Tab {
  return useTabStore().tabs.find((tab) => tab.id === id)!
}

describe('useRowPanel', () => {
  it('reads and writes the tab it was given', async () => {
    const { first } = await twoTables()
    const panel = useRowPanel(() => current(first.id))

    expect(panel.value).toBe(true)
    panel.value = false
    expect(panel.value).toBe(false)
    expect(current(first.id).showRowPanel).toBe(false)
  })

  it('leaves the other tab alone', async () => {
    const { first, second } = await twoTables()
    const left = useRowPanel(() => current(first.id))
    const right = useRowPanel(() => current(second.id))

    left.value = false

    expect(right.value).toBe(true)
    expect(current(second.id).showRowPanel).toBe(true)
  })

  it('leaves the choice as the way the next tab opens', async () => {
    const settings = useSettingsStore()
    const { first } = await twoTables()
    useRowPanel(() => current(first.id)).value = false
    expect(settings.settings.showRowPanel).toBe(false)

    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    expect(tabs.tabs[2].showRowPanel).toBe(false)
    // ...and the tab that was open when the choice was made still answers for
    // itself rather than following the setting.
    useRowPanel(() => current(first.id)).value = true
    expect(tabs.tabs[2].showRowPanel).toBe(false)
  })

  it('writes the setting only when the choice changes it', async () => {
    const settings = useSettingsStore()
    const { first, second } = await twoTables()
    const update = vi.mocked(settings.update)

    useRowPanel(() => current(first.id)).value = false
    expect(update).toHaveBeenCalledTimes(1)

    // The second tab is following the same choice; the setting already says so.
    useRowPanel(() => current(second.id)).value = false
    expect(update).toHaveBeenCalledTimes(1)
  })
})
