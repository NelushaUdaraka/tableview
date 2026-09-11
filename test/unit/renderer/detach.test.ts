/**
 * A tab dragged into a window of its own is described, not moved.
 *
 * Windows share no connection pool and no tab state, so anything that belongs
 * to the window a tab came from — staged edits, a result set, a cursor — must
 * not travel with it; what crosses is only enough to open the same thing again.
 */
import { describe, expect, it } from 'vitest'
import { detachedTabFrom } from '../../../src/renderer/src/lib/detach'
import type { QueryTab, TableTab } from '../../../src/renderer/src/stores/tabs'

const tableTab: TableTab = {
  id: 'tab-1',
  kind: 'table',
  title: 'customers',
  connectionId: 'c1',
  schema: 'dbo',
  table: 'customers',
  objectType: 'view',
  view: 'structure',
  pendingEdits: 3,
  filters: [{ column: 'id', operator: '=', value: '7' }],
  filterRevision: 2
}

const queryTab: QueryTab = {
  id: 'tab-2',
  kind: 'query',
  title: 'Monthly totals',
  connectionId: 'c1',
  sql: 'SELECT 1',
  cursor: 8,
  result: null,
  running: true,
  executionId: 'exec-1',
  activeResultIndex: 1,
  dirty: true,
  statementLine: 1
}

describe('detachedTabFrom', () => {
  it('carries what it takes to reopen a table', () => {
    expect(detachedTabFrom(tableTab)).toEqual({
      kind: 'table',
      connectionId: 'c1',
      title: 'customers',
      schema: 'dbo',
      table: 'customers',
      objectType: 'view',
      view: 'structure'
    })
  })

  it('carries the SQL of a query, and not the run it was in the middle of', () => {
    const payload = detachedTabFrom(queryTab)
    expect(payload).toEqual({
      kind: 'query',
      connectionId: 'c1',
      title: 'Monthly totals',
      sql: 'SELECT 1'
    })
    expect(payload).not.toHaveProperty('executionId')
    expect(payload).not.toHaveProperty('running')
  })

  it('leaves the old window\'s state behind', () => {
    const payload = detachedTabFrom(tableTab) as unknown as Record<string, unknown>
    // Staged edits belong to the view that is about to be unmounted; a tab that
    // carried a count of them would open claiming edits it does not have.
    expect(payload.pendingEdits).toBeUndefined()
    expect(payload.filters).toBeUndefined()
    expect(payload.id).toBeUndefined()
  })
})
