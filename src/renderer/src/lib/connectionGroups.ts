/**
 * Filing the connection list under group headings.
 *
 * A group is a name a connection carries, not a record of its own, so the
 * groups on screen are whatever the list says they are: naming one on a
 * connection creates it, taking the last connection out of one is what
 * removes it, and there is never an empty group to tidy away.
 */
import type { SavedConnection } from '@shared/types'

/** What the heading over the connections in no group reads. */
export const UNGROUPED_LABEL = 'Ungrouped'

export interface ConnectionGroup {
  /** The group's name; empty for the connections in none. */
  name: string
  label: string
  connections: SavedConnection[]
}

function collate(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** A connection's group, with the blanks and the stray spaces gone. */
export function groupNameOf(connection: Pick<SavedConnection, 'group'>): string {
  return connection.group?.trim() ?? ''
}

/**
 * The groups in use, in the order they are offered.
 *
 * Case-insensitively unique, because "Prod" and "prod" being two groups is
 * never what anyone meant by typing the second one.
 */
export function groupNames(connections: readonly SavedConnection[]): string[] {
  const byKey = new Map<string, string>()
  for (const connection of connections) {
    const name = groupNameOf(connection)
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name)
  }
  return [...byKey.values()].sort(collate)
}

/**
 * The list broken into its groups, each keeping the order it arrived in.
 *
 * The groups are alphabetical whatever the rows inside them are sorted by:
 * the sort answers "which connection", the grouping answers "where do I
 * look", and a heading that moved because a connection was opened would
 * answer neither. Ungrouped comes last — it is where things have not been
 * put yet, not the first place to look.
 */
export function groupConnections(connections: readonly SavedConnection[]): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>()
  const ungrouped: ConnectionGroup = { name: '', label: UNGROUPED_LABEL, connections: [] }

  for (const connection of connections) {
    const name = groupNameOf(connection)
    if (!name) {
      ungrouped.connections.push(connection)
      continue
    }
    const key = name.toLowerCase()
    const group = groups.get(key) ?? { name, label: name, connections: [] }
    group.connections.push(connection)
    groups.set(key, group)
  }

  const named = [...groups.values()].sort((a, b) => collate(a.name, b.name))
  return ungrouped.connections.length > 0 ? [...named, ungrouped] : named
}

/** Whether the list is worth drawing headings over at all. */
export function hasGroups(connections: readonly SavedConnection[]): boolean {
  return connections.some((connection) => groupNameOf(connection) !== '')
}
