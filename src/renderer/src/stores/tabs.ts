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
  /** Line the statement under the cursor starts on, reported by the status bar. */
  statementLine: number | null
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

/**
 * Asked before the active tab is left or closed; `false` cancels the move.
 *
 * Only the active tab is mounted, so only it can be holding work that leaving
 * would throw away — the view that owns that work registers this and answers
 * for it. Nothing is registered by default, and then every move goes through.
 */
export type LeaveGuard = () => Promise<boolean>

export const useTabStore = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([])
  const activeId = ref<string | null>(null)
  let leaveGuard: LeaveGuard | null = null

  /** Registered by the active view on mount, cleared on unmount. */
  function setLeaveGuard(guard: LeaveGuard | null): void {
    leaveGuard = guard
  }

  /** Runs `move` unless the tab being left asks to stay. */
  async function leaving(move: () => void): Promise<void> {
    if (leaveGuard && !(await leaveGuard())) return
    move()
  }

  const active = computed(() => tabs.value.find((tab) => tab.id === activeId.value) ?? null)
  const activeQueryTab = computed<QueryTab | null>(() =>
    active.value?.kind === 'query' ? active.value : null
  )
  const activeTableTab = computed<TableTab | null>(() =>
    active.value?.kind === 'table' ? active.value : null
  )

  async function openQuery(connectionId: string, sql = '', title = 'Query'): Promise<void> {
    await leaving(() => openQueryNow(connectionId, sql, title))
  }

  function openQueryNow(connectionId: string, sql: string, title: string): void {
    const existingUntitled = tabs.value.find(
      (tab): tab is QueryTab =>
        tab.kind === 'query' && tab.connectionId === connectionId && !tab.dirty && tab.sql === ''
    )
    // Reuse a blank tab rather than piling up empties.
    if (existingUntitled && sql === '') {
      activeId.value = existingUntitled.id
      return
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
      dirty: false,
      statementLine: null
    }
    tabs.value = [...tabs.value, tab]
    activeId.value = tab.id
  }

  async function openTable(
    connectionId: string,
    schema: string,
    table: string,
    objectType: SchemaObjectType = 'table',
    view: 'data' | 'structure' = 'data',
    filters?: TableFilter[]
  ): Promise<void> {
    await leaving(() => openTableNow(connectionId, schema, table, objectType, view, filters))
  }

  function openTableNow(
    connectionId: string,
    schema: string,
    table: string,
    objectType: SchemaObjectType,
    view: 'data' | 'structure',
    filters?: TableFilter[]
  ): void {
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
      return
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
  }

  async function close(id: string): Promise<void> {
    if (id === activeId.value) return leaving(() => closeNow(id))
    closeNow(id)
  }

  function closeNow(id: string): void {
    const index = tabs.value.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const next = tabs.value.filter((tab) => tab.id !== id)
    tabs.value = next
    if (activeId.value === id) {
      activeId.value = next[Math.min(index, next.length - 1)]?.id ?? null
    }
  }

  async function closeOthers(id: string): Promise<void> {
    // Only a move away from the active tab needs asking about.
    if (activeId.value !== null && activeId.value !== id) {
      return leaving(() => {
        tabs.value = tabs.value.filter((tab) => tab.id === id)
        activeId.value = id
      })
    }
    tabs.value = tabs.value.filter((tab) => tab.id === id)
    activeId.value = id
  }

  async function closeAll(): Promise<void> {
    await leaving(() => {
      tabs.value = []
      activeId.value = null
    })
  }

  function closeForConnection(connectionId: string): void {
    const next = tabs.value.filter((tab) => tab.connectionId !== connectionId)
    tabs.value = next
    if (!next.some((tab) => tab.id === activeId.value)) activeId.value = next[0]?.id ?? null
  }

  async function select(id: string): Promise<void> {
    if (id === activeId.value) return
    await leaving(() => {
      activeId.value = id
    })
  }

  async function cycle(delta: number): Promise<void> {
    if (tabs.value.length === 0) return
    const index = tabs.value.findIndex((tab) => tab.id === activeId.value)
    const next = (index + delta + tabs.value.length) % tabs.value.length
    await select(tabs.value[next].id)
  }

  /**
   * Applies a patch to one tab, leaving the state untouched when it changes
   * nothing.
   *
   * Every write replaces the tab object, and anything computed from that object
   * recomputes as a result. A write that changes no value would still invalidate
   * those computeds — enough for a watcher that writes back here to retrigger
   * itself indefinitely, which production builds have no recursion guard to
   * stop. Comparing first makes a no-op cost nothing.
   */
  function update<T extends Tab>(id: string, patch: Partial<T>): void {
    const current = tabs.value.find((tab) => tab.id === id) as T | undefined
    if (!current) return
    const changed = (Object.keys(patch) as (keyof T)[]).some(
      (key) => current[key] !== patch[key]
    )
    if (!changed) return
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
    update,
    setLeaveGuard
  }
})
