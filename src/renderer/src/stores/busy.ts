/**
 * Whether the window is waiting on the server, for the bar under the title bar.
 *
 * A count rather than a flag: a table reloading while a query runs in another
 * pane are two waits, and the bar has to stay up until the last one ends. Every
 * caller goes through `track`, so a rejected promise can never leave the bar
 * running.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useBusyStore = defineStore('busy', () => {
  const pending = ref(0)
  const busy = computed(() => pending.value > 0)

  function begin(): void {
    pending.value += 1
  }

  function end(): void {
    pending.value = Math.max(0, pending.value - 1)
  }

  /** Runs `work` with the bar up, whatever it settles as. */
  async function track<T>(work: () => Promise<T>): Promise<T> {
    begin()
    try {
      return await work()
    } finally {
      end()
    }
  }

  return { pending, busy, begin, end, track }
})
