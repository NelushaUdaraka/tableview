/**
 * Ordering the saved connection list.
 *
 * The list is read, not queried: there is no ORDER BY to re-issue, so the
 * screen reorders what it already holds. Which order that is belongs to the
 * reader — a list they made this morning is found by when they made it, one
 * they have carried for a year by name — so the key is a setting rather than
 * a rule, and this module is where the four of them are spelled out.
 */
import type {
  ConnectionSortDirection,
  ConnectionSortKey,
  SavedConnection
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

export interface ConnectionSortOption {
  key: ConnectionSortKey
  /** What the picker calls it. */
  label: string
  /**
   * The direction the key is worth reading in, which is what picking it
   * starts on: names climb, dates start with the newest.
   */
  defaultDirection: ConnectionSortDirection
  /** What each direction means, said in the flip control. */
  ascending: string
  descending: string
}

/** The keys offered, in the order the picker lists them. */
export const CONNECTION_SORT_OPTIONS: readonly ConnectionSortOption[] = [
  {
    key: 'created',
    label: 'Created',
    defaultDirection: 'desc',
    ascending: 'Oldest first',
    descending: 'Newest first'
  },
  {
    key: 'name',
    label: 'Name',
    defaultDirection: 'asc',
    ascending: 'A to Z',
    descending: 'Z to A'
  },
  {
    key: 'lastUsed',
    label: 'Last opened',
    defaultDirection: 'desc',
    ascending: 'Least recent first',
    descending: 'Most recent first'
  },
  {
    key: 'host',
    label: 'Endpoint',
    defaultDirection: 'asc',
    ascending: 'A to Z',
    descending: 'Z to A'
  }
] as const

const OPTIONS_BY_KEY = new Map(CONNECTION_SORT_OPTIONS.map((option) => [option.key, option]))

export function isConnectionSortKey(value: unknown): value is ConnectionSortKey {
  return typeof value === 'string' && OPTIONS_BY_KEY.has(value as ConnectionSortKey)
}

/**
 * The key to sort by, given whatever the settings file happens to hold.
 *
 * Settings survive upgrades and downgrades, so the stored key can be one this
 * build has never heard of; an unreadable preference falls back to the default
 * rather than leaving the list in no order at all.
 */
export function normaliseSortKey(value: unknown): ConnectionSortKey {
  return isConnectionSortKey(value) ? value : DEFAULT_SETTINGS.connectionSort
}

export function normaliseSortDirection(value: unknown): ConnectionSortDirection {
  return value === 'asc' || value === 'desc' ? value : DEFAULT_SETTINGS.connectionSortDirection
}

/** The direction a key opens in when it is picked. */
export function defaultDirectionFor(key: ConnectionSortKey): ConnectionSortDirection {
  return OPTIONS_BY_KEY.get(key)?.defaultDirection ?? 'desc'
}

/** How the active order reads, for the control that flips it. */
export function describeSort(
  key: ConnectionSortKey,
  direction: ConnectionSortDirection
): string {
  const option = OPTIONS_BY_KEY.get(key)
  if (!option) return ''
  return direction === 'asc' ? option.ascending : option.descending
}

function timeOf(iso?: string): number | null {
  if (!iso) return null
  const time = Date.parse(iso)
  return Number.isNaN(time) ? null : time
}

function compareText(a: string, b: string): number {
  // `numeric` keeps db2 above db10, which is what a reader expects of names
  // that end in a number — and most of them do.
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function byName(a: SavedConnection, b: SavedConnection): number {
  return compareText(a.name ?? '', b.name ?? '')
}

/**
 * One key's comparison, ascending, with absent values reported separately.
 *
 * A connection that has never been opened has no last-opened time — it is an
 * absent value rather than an early one, so it is pinned after everything in
 * both directions rather than flipping to the top of a descending list.
 */
function compareKey(
  key: ConnectionSortKey,
  a: SavedConnection,
  b: SavedConnection
): { order: number; pinned: boolean } {
  if (key === 'name') return { order: byName(a, b), pinned: false }

  if (key === 'host') {
    const host = compareText(a.host ?? '', b.host ?? '')
    return { order: host !== 0 ? host : (a.port ?? 0) - (b.port ?? 0), pinned: false }
  }

  const left = timeOf(key === 'created' ? a.createdAt : a.lastUsedAt)
  const right = timeOf(key === 'created' ? b.createdAt : b.lastUsedAt)
  if (left === null && right === null) return { order: 0, pinned: false }
  if (left === null) return { order: 1, pinned: true }
  if (right === null) return { order: -1, pinned: true }
  return { order: left - right, pinned: false }
}

/**
 * A copy of `connections` in the reader's order.
 *
 * Ties fall back to the name so that flipping the direction of a key half the
 * list shares — three connections made in the same minute — does not shuffle
 * rows the reader was just looking at.
 */
export function sortConnections(
  connections: readonly SavedConnection[],
  key: ConnectionSortKey,
  direction: ConnectionSortDirection
): SavedConnection[] {
  const sign = direction === 'asc' ? 1 : -1
  return [...connections].sort((a, b) => {
    const { order, pinned } = compareKey(key, a, b)
    // Pinned rows sit last whichever way the rest is read.
    if (pinned) return order
    if (order !== 0) return sign * order
    return byName(a, b)
  })
}
