/**
 * Where the workspace was left: sizes and choices that come back after a restart.
 *
 * Not settings — nobody picks these in a dialog, they are what the last drag
 * or click left behind — so they live in a file of their own
 * (`ui-state.json`) rather than among the preferences. Every window reads it
 * when it opens and writes back what it changes; the main process merges
 * those writes, so two windows remembering different tables do not undo one
 * another.
 */
import type { RoutineSource, SchemaObjectType } from './types'

export type SidebarPanel = 'objects' | 'history' | 'saved'

export interface UiState {
  /** Width of the schema sidebar, in pixels. */
  sidebarWidth: number
  /** Whether the sidebar was put away (`Ctrl+B`) in a full window. */
  sidebarCollapsed: boolean
  /** Which of Schema, History and Saved the sidebar shows. */
  sidebarPanel: SidebarPanel
  /** Height of a query tab's editor above its results, in pixels. */
  queryEditorHeight: number
  /**
   * Auto-refresh intervals in milliseconds, by `tableMemoryKey`. A table that
   * is off has no entry; the most recently set entries come last.
   */
  autoRefresh: Record<string, number>
  /** The tabs a window last had open, by saved connection id. */
  openTabs: Record<string, SavedTabs>
  /**
   * The database each connection was last switched to, by saved connection id,
   * when it is not the one the connection's settings name.
   */
  databases: Record<string, string>
}

/**
 * One tab as it is reopened: what it shows, never what it had read. Rows,
 * results and staged edits are not kept — a restored tab reads afresh.
 */
export interface SavedTab {
  kind: 'query' | 'table'
  title: string
  showRowPanel?: boolean
  /** Query tabs: the text, where the cursor was, and the saved query it is. */
  sql?: string
  cursor?: number
  savedQueryId?: string
  dirty?: boolean
  /** A query tab editing a routine; it reopens at the stored definition. */
  routine?: RoutineSource
  /** Table tabs. */
  schema?: string
  table?: string
  objectType?: SchemaObjectType
  view?: 'data' | 'structure'
  hiddenColumns?: string[]
}

export interface SavedPane {
  tabs: SavedTab[]
  /** Index of the tab the pane was showing. */
  active: number
}

export interface SavedTabs {
  /** One pane, or two when the workspace was split. */
  panes: SavedPane[]
  /** Index of the pane last clicked in. */
  focused: number
}

/**
 * What a window changes: any of the fields, only the tables it names, and
 * only the connection whose tabs it holds — `null` forgets that connection's.
 */
export type UiStatePatch = Partial<Omit<UiState, 'openTabs'>> & {
  openTabs?: Record<string, SavedTabs | null>
}

export const DEFAULT_UI_STATE: UiState = {
  sidebarWidth: 320,
  sidebarCollapsed: false,
  sidebarPanel: 'objects',
  queryEditorHeight: 336,
  autoRefresh: {},
  openTabs: {},
  databases: {}
}

/** Enough for every table anyone watches; past it, the longest-unset go first. */
export const MAX_REMEMBERED_TABLES = 200

const PANELS: readonly SidebarPanel[] = ['objects', 'history', 'saved']

/** Names one table across restarts: a tab's id does not outlive the window. */
export function tableMemoryKey(
  connectionId: string,
  database: string,
  schema: string,
  table: string
): string {
  return JSON.stringify([connectionId, database, schema, table])
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function text(value: unknown): value is string {
  return typeof value === 'string'
}

function savedTab(raw: unknown): SavedTab | null {
  if (!raw || typeof raw !== 'object') return null
  const tab = raw as Record<string, unknown>
  const common = {
    title: text(tab.title) ? tab.title : '',
    ...(typeof tab.showRowPanel === 'boolean' ? { showRowPanel: tab.showRowPanel } : {})
  }
  if (tab.kind === 'table') {
    if (!text(tab.schema) || !text(tab.table) || !tab.table) return null
    return {
      kind: 'table',
      ...common,
      title: common.title || tab.table,
      schema: tab.schema,
      table: tab.table,
      ...(['table', 'view'].includes(tab.objectType as string)
        ? { objectType: tab.objectType as SchemaObjectType }
        : {}),
      view: tab.view === 'structure' ? 'structure' : 'data',
      ...(Array.isArray(tab.hiddenColumns)
        ? { hiddenColumns: tab.hiddenColumns.filter(text) }
        : {})
    }
  }
  if (tab.kind === 'query') {
    if (!text(tab.sql)) return null
    const routine = tab.routine as Record<string, unknown> | undefined
    const validRoutine =
      routine && text(routine.schema) && text(routine.name) && text(routine.baseline)
    return {
      kind: 'query',
      ...common,
      title: common.title || 'Query',
      sql: tab.sql,
      ...(typeof tab.cursor === 'number' && tab.cursor >= 0 ? { cursor: tab.cursor } : {}),
      ...(text(tab.savedQueryId) ? { savedQueryId: tab.savedQueryId } : {}),
      ...(tab.dirty === true ? { dirty: true } : {}),
      ...(validRoutine ? { routine: routine as unknown as RoutineSource } : {})
    }
  }
  return null
}

/** A window's saved tabs, read back; null when there are none worth reopening. */
export function normalizeSavedTabs(raw: unknown): SavedTabs | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.panes)) return null
  const panes: SavedPane[] = []
  for (const rawPane of value.panes.slice(0, 2)) {
    const pane = (rawPane && typeof rawPane === 'object' ? rawPane : {}) as Record<string, unknown>
    const tabs = (Array.isArray(pane.tabs) ? pane.tabs : [])
      .map(savedTab)
      .filter((tab): tab is SavedTab => tab !== null)
    if (tabs.length === 0) continue
    const active = typeof pane.active === 'number' ? Math.floor(pane.active) : 0
    panes.push({ tabs, active: Math.max(0, Math.min(active, tabs.length - 1)) })
  }
  if (panes.length === 0) return null
  const focused = typeof value.focused === 'number' ? Math.floor(value.focused) : 0
  return { panes, focused: Math.max(0, Math.min(focused, panes.length - 1)) }
}

/**
 * Reads a stored state back, keeping what is valid and defaulting the rest:
 * the file is the user's to edit, and a bad value must not break a window.
 */
export function normalizeUiState(raw: unknown): UiState {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const autoRefresh: Record<string, number> = {}
  if (value.autoRefresh && typeof value.autoRefresh === 'object') {
    for (const [key, ms] of Object.entries(value.autoRefresh as Record<string, unknown>)) {
      if (positive(ms)) autoRefresh[key] = Math.round(ms)
    }
  }
  const openTabs: Record<string, SavedTabs> = {}
  if (value.openTabs && typeof value.openTabs === 'object') {
    for (const [id, saved] of Object.entries(value.openTabs as Record<string, unknown>)) {
      const tabs = normalizeSavedTabs(saved)
      if (tabs) openTabs[id] = tabs
    }
  }
  const databases: Record<string, string> = {}
  if (value.databases && typeof value.databases === 'object') {
    for (const [id, name] of Object.entries(value.databases as Record<string, unknown>)) {
      if (text(name) && name) databases[id] = name
    }
  }
  return {
    sidebarWidth: positive(value.sidebarWidth)
      ? Math.round(value.sidebarWidth)
      : DEFAULT_UI_STATE.sidebarWidth,
    sidebarCollapsed:
      typeof value.sidebarCollapsed === 'boolean'
        ? value.sidebarCollapsed
        : DEFAULT_UI_STATE.sidebarCollapsed,
    sidebarPanel: PANELS.includes(value.sidebarPanel as SidebarPanel)
      ? (value.sidebarPanel as SidebarPanel)
      : DEFAULT_UI_STATE.sidebarPanel,
    queryEditorHeight: positive(value.queryEditorHeight)
      ? Math.round(value.queryEditorHeight)
      : DEFAULT_UI_STATE.queryEditorHeight,
    autoRefresh,
    openTabs,
    databases
  }
}

/**
 * Applies a window's changes to the stored state.
 *
 * The tables in a patch are merged one by one rather than replacing the map,
 * and an interval of 0 forgets the table. A table set again moves to the end,
 * so trimming to `MAX_REMEMBERED_TABLES` drops the ones set longest ago.
 * Open tabs and databases merge per connection the same way: `null`, or an
 * empty database name, forgets that connection's.
 */
export function mergeUiState(current: UiState, patch: UiStatePatch): UiState {
  const { autoRefresh: tables, openTabs: windows, databases: switched, ...fields } = patch
  const next = normalizeUiState({ ...current, ...fields })
  const openTabs = { ...current.openTabs }
  for (const [id, saved] of Object.entries(windows ?? {})) {
    const tabs = normalizeSavedTabs(saved)
    if (tabs) openTabs[id] = tabs
    else delete openTabs[id]
  }
  const databases = { ...current.databases }
  for (const [id, name] of Object.entries(switched ?? {})) {
    if (text(name) && name) databases[id] = name
    else delete databases[id]
  }
  const autoRefresh = { ...current.autoRefresh }
  for (const [key, ms] of Object.entries(tables ?? {})) {
    delete autoRefresh[key]
    if (positive(ms)) autoRefresh[key] = Math.round(ms)
  }
  const keys = Object.keys(autoRefresh)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_TABLES))) {
    delete autoRefresh[key]
  }
  return { ...next, autoRefresh, openTabs, databases }
}

/** Drops everything remembered about a connection, once it is deleted. */
export function forgetConnection(current: UiState, connectionId: string): UiState {
  const prefix = JSON.stringify([connectionId]).slice(0, -1) + ','
  const autoRefresh = Object.fromEntries(
    Object.entries(current.autoRefresh).filter(([key]) => !key.startsWith(prefix))
  )
  const openTabs = { ...current.openTabs }
  delete openTabs[connectionId]
  const databases = { ...current.databases }
  delete databases[connectionId]
  return { ...current, autoRefresh, openTabs, databases }
}
