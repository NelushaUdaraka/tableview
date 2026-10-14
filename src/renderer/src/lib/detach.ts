/**
 * What travels with a tab dragged out into a window of its own.
 *
 * Windows share nothing: each has its own connection pool, its own tabs and
 * its own staged edits. So a detached tab is described, not moved — enough to
 * open the same table or the same SQL again, and nothing that belonged to the
 * window it came from.
 */
import type { DetachedTab } from '@shared/ipc'
import { useTabStore, type Tab } from '../stores/tabs'

export function detachedTabFrom(tab: Tab): DetachedTab {
  if (tab.kind === 'table') {
    return {
      kind: 'table',
      connectionId: tab.connectionId,
      title: tab.title,
      schema: tab.schema,
      table: tab.table,
      objectType: tab.objectType,
      view: tab.view
    }
  }
  return {
    kind: 'query',
    connectionId: tab.connectionId,
    title: tab.title,
    sql: tab.sql,
    // A routine's tab takes what is stored with it, so its changes are still
    // marked in the window it lands in.
    ...(tab.routine ? { routine: { ...tab.routine } } : {})
  }
}

/**
 * Opens a described tab in this window — the other half of `detachedTabFrom`.
 *
 * Used both for a tab arriving from another window and for one put back
 * because no window took it, so the two cannot disagree about what a
 * description means.
 */
export async function openTabFrom(tab: DetachedTab): Promise<void> {
  const tabs = useTabStore()

  if (tab.kind === 'table' && tab.schema && tab.table) {
    await tabs.openTable(
      tab.connectionId,
      tab.schema,
      tab.table,
      tab.objectType ?? 'table',
      tab.view ?? 'data'
    )
    return
  }

  if (tab.routine) {
    await tabs.openRoutine(tab.connectionId, tab.routine, { sql: tab.sql })
    return
  }

  await tabs.openQuery(tab.connectionId, tab.sql ?? '', tab.title)
}
