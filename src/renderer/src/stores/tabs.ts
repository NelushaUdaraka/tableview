import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { QueryExecutionResult, SchemaObjectType, TableFilter } from '@shared/types'

export interface QueryTab {
  id: string
  kind: 'query'
  title: string
  connectionId: string
  sql: string
  savedQueryId?: string
  /** Cursor offset, kept so a tab restores its position when reselected. */
  cursor: number
  result: QueryExecutionResult | null
  running: boolean
  executionId: string | null
  activeResultIndex: number
  dirty: boolean
}

export interface TableTab {
  id: string
  kind: 'table'
  title: string
  connectionId: string
  schema: string
  table: string
  objectType: SchemaObjectType
  view: 'data' | 'structure'
  /** Unsaved grid edits, so switching tabs does not discard them. */
  pendingEdits: number
  /** Filters the tab opens with — how following a foreign key lands on a row. */
  filters?: TableFilter[]
  /**
   * Bumped every time `filters` is set. Reopening a table reuses its tab, so
   * the view needs a signal that the filters are new even when the tab is not.
   */
  filterRevision: number
}

export type Tab = QueryTab | TableTab

let counter = 0
const newId = (): string => `tab-${++counter}`

export const useTabStore = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([])
  const activeId = ref<string | null>(null)

  const active = computed(() => tabs.value.find((tab) => tab.id === activeId.value) ?? null)
  const activeQueryTab = computed<QueryTab | null>(() =>
    active.value?.kind === 'query' ? active.value : null
  )
  const activeTableTab = computed<TableTab | null>(() =>
    active.value?.kind === 'table' ? active.value : null
  )

  function openQuery(connectionId: string, sql = '', title = 'Query'): QueryTab {
    const existingUntitled = tabs.value.find(
      (tab): tab is QueryTab =>
        tab.kind === 'query' && tab.connectionId === connectionId && !tab.dirty && tab.sql === ''
    )
    // Reuse a blank tab rather than piling up empties.
    if (existingUntitled && sql === '') {
      activeId.value = existingUntitled.id
      return existingUntitled
    }

    const tab: QueryTab = {
      id: newId(),
      kind: 'query',
      title,
      connectionId,
      sql,
      cursor: sql.length,
      result: null,
      running: false,
      executionId: null,
      activeResultIndex: 0,
      dirty: false
    }
    tabs.value = [...tabs.value, tab]
    activeId.value = tab.id
    return tab
  }

  function openTable(
    connectionId: string,
    schema: string,
    table: string,
    objectType: SchemaObjectType = 'table',
    view: 'data' | 'structure' = 'data',
    filters?: TableFilter[]
  ): TableTab {
    const existing = tabs.value.find(
      (tab): tab is TableTab =>
        tab.kind === 'table' &&
        tab.connectionId === connectionId &&
        tab.schema === schema &&
        tab.table === table
    )
    if (existing) {
      existing.view = view
      if (filters) {
        existing.filters = filters
        existing.filterRevision += 1
      }
      activeId.value = existing.id
      return existing
    }

    const tab: TableTab = {
      id: newId(),
      kind: 'table',
      title: table,
      connectionId,
      schema,
      table,
      objectType,
      view,
      pendingEdits: 0,
      filters,
      filterRevision: filters ? 1 : 0
    }
    tabs.value = [...tabs.value, tab]
    activeId.value = tab.id
    return tab
  }

  function close(id: string): void {
    const index = tabs.value.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const next = tabs.value.filter((tab) => tab.id !== id)
    tabs.value = next
    if (activeId.value === id) {
      activeId.value = next[Math.min(index, next.length - 1)]?.id ?? null
    }
  }

  function closeOthers(id: string): void {
    tabs.value = tabs.value.filter((tab) => tab.id === id)
    activeId.value = id
  }

  function closeAll(): void {
    tabs.value = []
    activeId.value = null
  }

  function closeForConnection(connectionId: string): void {
    const next = tabs.value.filter((tab) => tab.connectionId !== connectionId)
    tabs.value = next
    if (!next.some((tab) => tab.id === activeId.value)) activeId.value = next[0]?.id ?? null
  }

  function select(id: string): void {
    activeId.value = id
  }

  function cycle(delta: number): void {
    if (tabs.value.length === 0) return
    const index = tabs.value.findIndex((tab) => tab.id === activeId.value)
    const next = (index + delta + tabs.value.length) % tabs.value.length
    activeId.value = tabs.value[next].id
  }

  function update<T extends Tab>(id: string, patch: Partial<T>): void {
    tabs.value = tabs.value.map((tab) => (tab.id === id ? ({ ...tab, ...patch } as Tab) : tab))
  }

  return {
    tabs,
    activeId,
    active,
    activeQueryTab,
    activeTableTab,
    openQuery,
    openTable,
    close,
    closeOthers,
    closeAll,
    closeForConnection,
    select,
    cycle,
    update
  }
})
