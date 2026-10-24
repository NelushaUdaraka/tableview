/**
 * The question a confirm-writes connection asks before anything that writes:
 * a script, staged table edits, truncate or drop.
 *
 * Asked from wherever the write starts — a query tab, a table's Apply, the
 * tree's menu — and answered by one dialog over the window. Whatever the
 * answer, the main process still checks: a write that does not come marked as
 * confirmed is refused there.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WriteItem } from '../lib/confirmWrites'
import { useConnectionStore } from './connections'

export interface WriteQuestion {
  /** The question, as the dialog's title: `Run this script?` */
  title: string
  /** The button that goes ahead: `Run anyway`. */
  action: string
  /** The connection, by name, and where it points. */
  connection: string
  server: string
  items: WriteItem[]
  /** Anything else worth knowing before saying yes. */
  note?: string
}

export interface PendingWriteQuestion extends WriteQuestion {
  resolve: (proceed: boolean) => void
}

export const useConfirmWritesStore = defineStore('confirmWrites', () => {
  const connections = useConnectionStore()
  const question = ref<PendingWriteQuestion | null>(null)

  /** Whether the open connection asks before it writes. */
  const asking = (): boolean => connections.writeMode === 'confirm'

  /** Resolves true once the user says to go ahead, false on anything else. */
  function ask(next: WriteQuestion): Promise<boolean> {
    // A question already on screen is withdrawn rather than left unanswered.
    question.value?.resolve(false)
    return new Promise((resolve) => {
      question.value = { ...next, resolve }
    })
  }

  /** Asks about `items` on the open connection. */
  function askAbout(
    items: WriteItem[],
    wording: { title: string; action: string; note?: string }
  ): Promise<boolean> {
    const connection = connections.active
    return ask({
      ...wording,
      connection: connection?.name ?? '',
      server: connection ? `${connection.host}:${connection.port}` : '',
      items
    })
  }

  function answer(proceed: boolean): void {
    const current = question.value
    question.value = null
    current?.resolve(proceed)
  }

  return { question, asking, ask, askAbout, answer }
})
