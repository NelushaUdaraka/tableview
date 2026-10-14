/**
 * What travels with a tab dragged out into a window of its own.
 *
 * Windows share nothing: each has its own connection pool, its own tabs and
 * its own staged edits. So a detached tab is described, not moved — enough to
 * open the same table or the same SQL again, and nothing that belonged to the
 * window it came from.
 */
import type { DetachedTab } from '@shared/ipc'
import { useTabStore, type Tab, type TableTab } from '../stores/tabs'

export function detachedTabFrom(tab: Tab): DetachedTab {
  if (tab.kind === 'table') {
    return {
      kind: 'table',
      connectionId: tab.connectionId,
      title: tab.title,
      schema: tab.schema,
      table: tab.table,
      objectType: tab.objectType,
      view: tab.view,
      // A table being watched keeps being watched wherever it is put.
      ...(tab.autoRefresh ? { autoRefresh: tab.autoRefresh } : {})
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
    if (tab.autoRefresh) {
      const opened = tabs.tabs.find(
        (entry): entry is TableTab =>
          entry.kind === 'table' &&
          entry.connectionId === tab.connectionId &&
          entry.schema === tab.schema &&
          entry.table === tab.table
      )
      if (opened) tabs.update<TableTab>(opened.id, { autoRefresh: tab.autoRefresh })
    }
    return
  }

  if (tab.routine) {
    await tabs.openRoutine(tab.connectionId, tab.routine, { sql: tab.sql })
    return
  }

  await tabs.openQuery(tab.connectionId, tab.sql ?? '', tab.title)
}
