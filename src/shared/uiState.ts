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
}

/** What a window changes: any of the fields, and only the tables it names. */
export type UiStatePatch = Partial<UiState>

export const DEFAULT_UI_STATE: UiState = {
  sidebarWidth: 320,
  sidebarCollapsed: false,
  sidebarPanel: 'objects',
  queryEditorHeight: 336,
  autoRefresh: {}
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
    autoRefresh
  }
}

/**
 * Applies a window's changes to the stored state.
 *
 * The tables in a patch are merged one by one rather than replacing the map,
 * and an interval of 0 forgets the table. A table set again moves to the end,
 * so trimming to `MAX_REMEMBERED_TABLES` drops the ones set longest ago.
 */
export function mergeUiState(current: UiState, patch: UiStatePatch): UiState {
  const { autoRefresh: tables, ...fields } = patch
  const next = normalizeUiState({ ...current, ...fields })
  const autoRefresh = { ...current.autoRefresh }
  for (const [key, ms] of Object.entries(tables ?? {})) {
    delete autoRefresh[key]
    if (positive(ms)) autoRefresh[key] = Math.round(ms)
  }
  const keys = Object.keys(autoRefresh)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_TABLES))) {
    delete autoRefresh[key]
  }
  return { ...next, autoRefresh }
}
