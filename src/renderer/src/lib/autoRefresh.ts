/**
 * A table that re-reads itself on a timer.
 *
 * Off unless asked for, and per tab: a table left open on a second screen to
 * watch a queue drain is one tab, and every other table in the window has no
 * reason to be re-read behind the reader's back. The choices are a fixed few,
 * from a few seconds for something being watched to a quarter of an hour for
 * something merely kept current.
 *
 * Each read is the background re-read a tab already does when it is picked
 * again: nothing is dimmed, and the grid only hears about rows that actually
 * changed. The next one is timed from when the last one finished rather than
 * from when it started, so a slow table is never asked twice at once.
 */

export interface AutoRefreshChoice {
  /** The interval in milliseconds; 0 is off. */
  ms: number
  /** As the picker lists it. */
  label: string
  /** As the toolbar shows it once it is on. */
  short: string
}

export const AUTO_REFRESH_CHOICES: readonly AutoRefreshChoice[] = [
  { ms: 0, label: 'Off', short: 'Off' },
  { ms: 5_000, label: 'Every 5 seconds', short: '5s' },
  { ms: 10_000, label: 'Every 10 seconds', short: '10s' },
  { ms: 30_000, label: 'Every 30 seconds', short: '30s' },
  { ms: 60_000, label: 'Every minute', short: '1m' },
  { ms: 300_000, label: 'Every 5 minutes', short: '5m' },
  { ms: 900_000, label: 'Every 15 minutes', short: '15m' }
]

export function autoRefreshChoice(ms: number): AutoRefreshChoice {
  return (
    AUTO_REFRESH_CHOICES.find((choice) => choice.ms === ms) ?? {
      ms,
      label: `Every ${Math.round(ms / 1000)} seconds`,
      short: `${Math.round(ms / 1000)}s`
    }
  )
}

/** What the view knows at the moment a read falls due. */
export interface AutoRefreshConditions {
  connected: boolean
  stagedEdits: number
  /** A cell or a field holds typing that has not been committed yet. */
  editing: boolean
  /** A read or an apply is under way, or a menu or a dialog is open over the rows. */
  busy: boolean
  /** The window is minimised, or otherwise out of sight. */
  hidden: boolean
}

export type AutoRefreshHold = 'offline' | 'staged' | 'editing' | 'busy' | 'hidden'

/**
 * Why a read that has fallen due should let its turn pass, or null when it
 * should go ahead.
 *
 * Staged edits are what matter most: they are keyed by the row they sit in,
 * so rows that moved under them would carry every edit onto a different row.
 * A cell being typed into is the same thing one keystroke earlier. The rest
 * is not getting in the way — a read already on its way, a menu open on a row
 * that could move, a window nobody can see — and a connection that is down
 * has nothing to read from; the status bar is already saying so.
 */
export function autoRefreshHold(conditions: AutoRefreshConditions): AutoRefreshHold | null {
  if (!conditions.connected) return 'offline'
  if (conditions.stagedEdits > 0) return 'staged'
  if (conditions.editing) return 'editing'
  if (conditions.busy) return 'busy'
  if (conditions.hidden) return 'hidden'
  return null
}

export interface AutoRefresher {
  /** The interval it is running at; 0 when it is off. */
  readonly interval: number
  /** Sets the interval — 0 stops it — and with `now` reads straight away too. */
  set(ms: number, now?: boolean): void
  /** Reads now, unless something holds it, and times the next read from then. */
  now(): void
  /** Stops for good, for a view that is going away. */
  dispose(): void
}

export function createAutoRefresher(options: {
  /** True when the read that is due should let its turn pass. */
  hold: () => boolean
  /** Reads the rows again, resolving false when the read failed. */
  refresh: () => Promise<boolean>
  /**
   * A read failed, and the timer has stopped because of it. Retrying on a
   * timer would raise the same error every few seconds — and a failure that
   * is worth retrying, a connection dropping, is held off before it is tried.
   */
  onFailure: () => void
}): AutoRefresher {
  let interval = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  /**
   * Bumped whenever the schedule changes, so a read that finishes for a
   * schedule that has since been replaced does not set another one going.
   */
  let generation = 0
  let disposed = false

  function clear(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function schedule(): void {
    clear()
    if (interval > 0 && !disposed) timer = setTimeout(() => void tick(), interval)
  }

  async function tick(): Promise<void> {
    timer = null
    if (interval === 0 || disposed) return
    const mine = generation
    if (!options.hold()) {
      const ok = await options.refresh()
      if (mine !== generation || disposed) return
      if (!ok) {
        interval = 0
        generation += 1
        options.onFailure()
        return
      }
    }
    schedule()
  }

  function now(): void {
    if (interval === 0 || disposed) return
    clear()
    generation += 1
    void tick()
  }

  return {
    get interval() {
      return interval
    },
    set(ms: number, immediately = false): void {
      const next = Math.max(0, ms)
      if (next !== interval) {
        interval = next
        generation += 1
        schedule()
      }
      if (immediately) now()
    },
    now,
    dispose(): void {
      disposed = true
      generation += 1
      clear()
    }
  }
}
