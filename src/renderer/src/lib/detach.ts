/**
 * What travels with a tab dragged out into a window of its own.
 *
 * Windows share nothing: each has its own connection pool, its own tabs and
 * its own staged edits. So a detached tab is described, not moved — enough to
 * open the same table or the same SQL again, and nothing that belonged to the
 * window it came from.
 */
import type { DetachedTab } from '@shared/ipc'
import type { Tab } from '../stores/tabs'

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
    sql: tab.sql
  }
}
