/**
 * Switching a connection's read-only and confirm writes, and asking before it
 * starts writing freely.
 *
 * Anything that makes a connection safer simply happens. The switch that
 * leaves it writing without asking — read-only off on a connection that does
 * not confirm its writes, or confirm writes off on one that is not read-only —
 * is the moment the window starts writing to whatever the connection points
 * at, production as often as not, so it waits for the user to say they mean
 * it. Read-only off on a connection that confirms its writes does not ask:
 * every write is still asked about. The question lives here because the
 * status bar, the connection list and the form all raise it, and one dialog
 * over the whole window answers it.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SavedConnection } from '@shared/types'
import { switchAsks, writeModeOf, type WriteGuard, type WriteMode } from '@shared/writeMode'
import { useConnectionStore } from './connections'
import { useToastStore } from './toasts'

export interface WritablePrompt {
  connection: SavedConnection
  /** What it is leaving: read-only, or confirm writes. */
  from: WriteMode
  resolve: (proceed: boolean) => void
}

export const useReadOnlyStore = defineStore('readOnly', () => {
  const connections = useConnectionStore()
  const toasts = useToastStore()
  const prompt = ref<WritablePrompt | null>(null)

  /**
   * Asks whether `connection` may write freely; false when the answer is no.
   * `from` is the mode it would leave, which the question names.
   */
  function confirmWritable(
    connection: SavedConnection,
    from: WriteMode = writeModeOf(connection)
  ): Promise<boolean> {
    // A question already on screen is withdrawn rather than left unanswered.
    prompt.value?.resolve(false)
    return new Promise((resolve) => {
      prompt.value = { connection, from, resolve }
    })
  }

  function answer(proceed: boolean): void {
    const current = prompt.value
    prompt.value = null
    current?.resolve(proceed)
  }

  /** Saves both switches, asking first when that leaves it writing freely. */
  async function setGuard(
    connection: SavedConnection,
    guard: WriteGuard,
    done: string
  ): Promise<boolean> {
    const from = writeModeOf(connection)
    if (switchAsks(from, writeModeOf(guard)) && !(await confirmWritable(connection, from))) {
      return false
    }
    try {
      await connections.setWriteGuard(connection, guard)
    } catch (error) {
      toasts.fromError('Could not change how this connection writes', error)
      return false
    }
    toasts.info(done)
    return true
  }

  /**
   * Turns read-only on, or — once the user has said so, if it has to ask —
   * off. True when it changed.
   */
  function setReadOnly(connection: SavedConnection, readOnly: boolean): Promise<boolean> {
    const confirmWrites = connection.confirmWrites === true
    return setGuard(
      connection,
      { readOnly, confirmWrites },
      readOnly
        ? `“${connection.name}” is read-only`
        : confirmWrites
          ? `“${connection.name}” can write again, once each write is confirmed`
          : `“${connection.name}” can write again`
    )
  }

  /** Turns confirm writes on, or off — asking first if that leaves it writing freely. */
  function setConfirmWrites(connection: SavedConnection, confirmWrites: boolean): Promise<boolean> {
    const readOnly = connection.readOnly === true
    return setGuard(
      connection,
      { readOnly, confirmWrites },
      confirmWrites
        ? readOnly
          ? `“${connection.name}” will confirm writes once read-only is off`
          : `“${connection.name}” asks before each write`
        : readOnly
          ? `“${connection.name}” will not confirm writes once read-only is off`
          : `“${connection.name}” no longer asks before writing`
    )
  }

  return { prompt, confirmWritable, answer, setReadOnly, setConfirmWrites }
})
