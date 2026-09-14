/**
 * A tab's row panel, as one thing a view can read and set.
 *
 * The panel used to be an app setting, which made it an app-wide answer: two
 * tables open side by side in a split are there to be compared, and hiding the
 * fields of one of them hid the other's too. The tab owns it instead, and the
 * setting is left saying how the *next* tab opens — so a choice made here is
 * also the one a tab opened later starts from, without reaching back into the
 * tabs that are already open and each have an answer of their own.
 */
import { computed, type WritableComputedRef } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useTabStore, type Tab } from '../stores/tabs'

export function useRowPanel(tab: () => Tab): WritableComputedRef<boolean> {
  const tabs = useTabStore()
  const settings = useSettingsStore()

  return computed({
    get: () => tab().showRowPanel,
    set: (visible: boolean) => {
      tabs.update(tab().id, { showRowPanel: visible })
      if (settings.settings.showRowPanel !== visible) {
        void settings.update({ showRowPanel: visible })
      }
    }
  })
}
