/**
 * What a window asks of the main process about a query tab's session: to end
 * it, and to stop the query running on it.
 *
 * The tab store decides when — closing a tab, moving it, disconnecting — and
 * these carry it out. They take what they need from the tab rather than the
 * store, so the store can use them without the two importing each other.
 */
import type { QueryTab } from '../stores/tabs'
import { api } from './api'

/** How long a close waits for a running query to stop before going ahead anyway. */
export const STOP_WAIT_MS = 10_000

/** Ends a tab's session, rolling back whatever is open; by now that has been asked about. */
export async function endSession(tab: Pick<QueryTab, 'connectionId' | 'id'>): Promise<void> {
  try {
    await api.closeSession(tab.connectionId, tab.id)
  } catch {
    // A connection already gone took the session with it.
  }
}

/**
 * Stops the query a tab is running, the way its Cancel button does, and
 * resolves once the run has come back: true when it stopped, false when it
 * was still going after `waitMs`.
 */
export async function stopRun(
  tab: Pick<QueryTab, 'connectionId' | 'executionId'>,
  isRunning: () => boolean,
  waitMs = STOP_WAIT_MS
): Promise<boolean> {
  if (tab.executionId) {
    await api.cancelQuery(tab.connectionId, tab.executionId).catch(() => false)
  }
  const end = Date.now() + waitMs
  while (isRunning()) {
    if (Date.now() >= end) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}
