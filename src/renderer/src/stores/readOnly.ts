/**
 * Switching a connection's read-only, and asking before it comes off.
 *
 * Turning it on only ever makes a connection safer, so it simply happens.
 * Turning it off is the moment the window starts writing to whatever the
 * connection points at — production, as often as not — so it waits for the
 * user to say they mean it. The question lives here because the status bar,
 * the connection list's menu and the form all raise it, and one dialog over
 * the whole window answers it.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SavedConnection } from '@shared/types'
import { useConnectionStore } from './connections'
import { useToastStore } from './toasts'

export interface WritablePrompt {
  connection: SavedConnection
  resolve: (proceed: boolean) => void
}

export const useReadOnlyStore = defineStore('readOnly', () => {
  const connections = useConnectionStore()
  const toasts = useToastStore()
  const prompt = ref<WritablePrompt | null>(null)

  /** Asks whether `connection` may write again; false when the answer is no. */
  function confirmWritable(connection: SavedConnection): Promise<boolean> {
    // A question already on screen is withdrawn rather than left unanswered.
    prompt.value?.resolve(false)
    return new Promise((resolve) => {
      prompt.value = { connection, resolve }
    })
  }

  function answer(proceed: boolean): void {
    const current = prompt.value
    prompt.value = null
    current?.resolve(proceed)
  }

  /** Turns read-only on, or — once the user has said so — off. True when it changed. */
  async function setReadOnly(connection: SavedConnection, readOnly: boolean): Promise<boolean> {
    if (!readOnly && !(await confirmWritable(connection))) return false
    try {
      await connections.setReadOnly(connection, readOnly)
    } catch (error) {
      toasts.fromError('Could not change read-only', error)
      return false
    }
    toasts.info(
      readOnly ? `“${connection.name}” is read-only` : `“${connection.name}” can write again`
    )
    return true
  }

  return { prompt, confirmWritable, answer, setReadOnly }
})
