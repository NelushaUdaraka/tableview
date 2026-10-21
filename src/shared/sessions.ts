/**
 * A query tab's session: the rules both sides of the window share.
 *
 * The main process decides with them — whether a session follows the sidebar
 * to another database, whether a run may go ahead after the session was lost —
 * and the window draws with them, so they live here, pure.
 */
import type { SessionState } from './types'

/** Commits every level of nesting: one `COMMIT` only takes `@@TRANCOUNT` down by one. */
export const COMMIT_SQL = 'WHILE @@TRANCOUNT > 0 COMMIT TRANSACTION;'

/** Rolls back whatever is open; with nothing open a bare `ROLLBACK` is an error. */
export const ROLLBACK_SQL = 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;'

/**
 * What a tab is told after every run, read on its own session.
 *
 * `XACT_STATE()` is read in a statement of its own: in the same `SELECT` as
 * `DB_NAME()`, whose metadata lookup runs inside a transaction of its own, it
 * reports 1 with nothing open.
 */
export const STATE_SQL =
  'DECLARE @state smallint = XACT_STATE(); ' +
  'SELECT @@TRANCOUNT AS transactionCount, @state AS transactionState, DB_NAME() AS [database];'

/** Database names compare without case, as they do under the usual server collation. */
export function sameDatabase(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

/** What the database rule needs to know about a session. */
export interface SessionPlace {
  database: string
  transactionCount: number
  /** A routine's tab, which belongs to the routine's database. */
  pinned: boolean
  /** A run is in flight on it, so nothing else can be sent until it ends. */
  running: boolean
}

export type FollowDecision = 'follow' | 'stay' | 'later'

/**
 * What a session does when the sidebar switches away from `fromDatabase`.
 *
 * A tab is moved along only while it is where the sidebar was: one that ran a
 * `USE` of its own chose its database, a routine's tab belongs to its
 * routine's, and one in a transaction is not moved under it. A running tab
 * cannot be sent anything until its run ends, so it is asked again then.
 */
export function followDecision(session: SessionPlace, fromDatabase: string): FollowDecision {
  if (session.pinned) return 'stay'
  if (session.transactionCount > 0) return 'stay'
  if (!sameDatabase(session.database, fromDatabase)) return 'stay'
  if (session.running) return 'later'
  return 'follow'
}

/**
 * Whether the run after a lost session is turned down.
 *
 * A script written to carry on inside a transaction would be committed
 * statement by statement on a new session, and one written for a database the
 * tab had moved to would run in the one a new session opens in. Anything else
 * the session held — temp tables, settings — fails loudly or not at all, which
 * is not worth a refused run every time a laptop wakes.
 */
export function refuseAfterLoss(had: SessionState, nextDatabase: string): boolean {
  return had.transactionCount > 0 || !sameDatabase(had.database, nextDatabase)
}

/**
 * The state as read, with when its transaction opened carried over: the
 * server says a transaction is open, not since when, so the first sight of it
 * is the time kept.
 */
export function withTransactionSince(
  previous: SessionState | null | undefined,
  next: Omit<SessionState, 'transactionSince'>,
  now: Date
): SessionState {
  const { transactionCount, transactionState, database } = next
  if (transactionCount <= 0) return { transactionCount, transactionState, database }
  const since =
    previous && previous.transactionCount > 0 && previous.transactionSince
      ? previous.transactionSince
      : now.toISOString()
  return { transactionCount, transactionState, database, transactionSince: since }
}

export function transactionOpen(session: SessionState | null | undefined): boolean {
  return (session?.transactionCount ?? 0) > 0
}

/** An error inside `XACT_ABORT` or a `CATCH` can leave a transaction that only rolls back. */
export function canCommit(session: SessionState | null | undefined): boolean {
  return transactionOpen(session) && session!.transactionState !== -1
}

/** How long a transaction has been open, as the toolbar says it: `12s`, `4m`, `1h 5m`. */
export function transactionAge(since: string | undefined, now: Date): string {
  if (!since) return ''
  const opened = Date.parse(since)
  if (Number.isNaN(opened)) return ''
  const seconds = Math.max(0, Math.floor((now.getTime() - opened) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
}

/** What a tab says once, when the session it had is gone. */
export function lostSessionNote(had: SessionState): string {
  const gone = "This tab's session was closed — temp tables and settings from earlier runs are gone"
  return had.transactionCount > 0
    ? `${gone}, and its open transaction was rolled back by the server.`
    : `${gone}.`
}

/** What a run that was turned down says instead of results. */
export function lostSessionRefusal(had: SessionState, nextDatabase: string): string {
  return `${lostSessionNote(had)} Nothing was run; run again to start a new session in ${nextDatabase}.`
}
