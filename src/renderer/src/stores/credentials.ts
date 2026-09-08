/**
 * The one place that answers "these AWS credentials have run out".
 *
 * Expiry can surface from anywhere — opening a connection, testing one, or a
 * query failing hours later because the session died underneath it — and the
 * answer is always the same: paste a fresh block and carry on. Holding the
 * prompt here lets every one of those places raise it with a single call
 * instead of each growing its own dialog.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { SSM_CREDENTIALS_EXPIRED, type SavedConnection, type SerializedError } from '@shared/types'

/** Whether this failure is the kind fresh credentials would fix. */
export function isExpiredCredentialsError(error: unknown): boolean {
  if (!error) return false
  const code = (error as SerializedError | { code?: unknown }).code
  return code === SSM_CREDENTIALS_EXPIRED
}

export interface CredentialsPrompt {
  connection: SavedConnection
  /** What the failure said, so the dialog can show it rather than a guess. */
  message: string
  /** Run after a fresh block is saved; the caller decides what "again" means. */
  retry?: () => void | Promise<void>
}

export const useCredentialsStore = defineStore('credentials', () => {
  const prompt = ref<CredentialsPrompt | null>(null)

  /**
   * Raises the prompt when `error` is an expiry, and reports whether it did —
   * so callers can skip the toast they would otherwise show.
   */
  function offerRefresh(
    connection: SavedConnection | null | undefined,
    error: unknown,
    retry?: () => void | Promise<void>
  ): boolean {
    if (!connection || !isExpiredCredentialsError(error)) return false
    prompt.value = {
      connection,
      message:
        (error as SerializedError | Error | undefined)?.message ??
        'The AWS credentials for this connection have expired.',
      retry
    }
    return true
  }

  function dismiss(): void {
    prompt.value = null
  }

  return { prompt, offerRefresh, dismiss }
})
