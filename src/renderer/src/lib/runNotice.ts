/**
 * The desktop notification a long query sends when it finishes behind your
 * back: whether to send one, and what it says.
 *
 * Only a run that took a while, in a window that is not the one in front, is
 * worth a word — anything else was either quick or watched, and a
 * notification for every run would soon be one nobody reads.
 */
import type { AppSettings, QueryExecutionResult } from '@shared/types'

/** The shortest threshold the setting takes, so "0" does not mean every run. */
export const MIN_NOTIFY_SECONDS = 1

export interface RunOutcome {
  /** Wall-clock time the run took, from pressing Run to its answer. */
  elapsedMs: number
  result?: QueryExecutionResult
  /** A failure that came back as an exception rather than in a statement. */
  error?: string
}

export interface RunNotice {
  title: string
  body: string
}

/** Whether a run that just ended should say so on the desktop. */
export function shouldNotify(
  outcome: RunOutcome,
  windowFocused: boolean,
  settings: Pick<AppSettings, 'notifyLongQueries' | 'notifyAfterSeconds'>
): boolean {
  if (!settings.notifyLongQueries || windowFocused) return false
  // A cancel was asked for, by someone who is evidently watching.
  if (outcome.result?.cancelled) return false
  const seconds = Math.max(MIN_NOTIFY_SECONDS, Number(settings.notifyAfterSeconds) || 0)
  return outcome.elapsedMs >= seconds * 1000
}

/** `14 s`, `2 min 5 s`, `1 h 3 min`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/** How long a notification's error line may be; the rest is in the tab. */
const MAX_ERROR_LENGTH = 140

function shorten(message: string): string {
  const line = message.split(/\r?\n/).find((part) => part.trim() !== '') ?? message
  const text = line.trim()
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/** What the notification says: which tab ran, how long it took, and how it went. */
export function runNotice(tabTitle: string, outcome: RunOutcome): RunNotice {
  const took = formatElapsed(outcome.elapsedMs)
  const failure =
    outcome.error ?? outcome.result?.statements.find((statement) => statement.error)?.error?.message

  if (failure !== undefined) {
    return { title: `${tabTitle} failed`, body: `Failed after ${took}: ${shorten(failure)}` }
  }

  const statements = outcome.result?.statements ?? []
  const sets = statements.flatMap((statement) => statement.resultSets)
  const affected = statements.flatMap((statement) => statement.rowsAffected)
  let what = ''
  if (sets.length > 0) {
    const rows = sets.reduce((sum, set) => sum + set.rowCount, 0)
    what = plural(rows, 'row', 'rows')
    if (sets.length > 1) what += ` in ${sets.length} results`
  } else if (affected.length > 0) {
    what = `${plural(affected.reduce((sum, n) => sum + n, 0), 'row', 'rows')} affected`
  }
  return {
    title: `${tabTitle} finished`,
    body: what ? `Finished in ${took} · ${what}` : `Finished in ${took}`
  }
}
