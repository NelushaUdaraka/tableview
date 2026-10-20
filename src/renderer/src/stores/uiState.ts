import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  DEFAULT_UI_STATE,
  mergeUiState,
  tableMemoryKey,
  type SavedTabs,
  type UiState,
  type UiStatePatch
} from '@shared/uiState'
import { api } from '../lib/api'

/**
 * Dragging a divider changes its size on every mouse move; only where it comes
 * to rest is worth a write to disk.
 */
export const REMEMBER_DELAY_MS = 400

/**
 * The workspace's remembered layout, for this window.
 *
 * Read once as the window opens; a view takes its starting size or choice from
 * here and calls `remember` when the reader changes it. Writes are gathered
 * and sent together once things settle, and sent at once when the window goes.
 */
export const useUiStateStore = defineStore('uiState', () => {
  const state = ref<UiState>({ ...DEFAULT_UI_STATE, autoRefresh: {} })
  let pending: UiStatePatch | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  async function load(): Promise<void> {
    state.value = await api.getUiState()
  }

  function flush(): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (!pending) return
    const patch = pending
    pending = null
    // Forgetting a size is not worth interrupting anyone over.
    api.updateUiState(patch).catch(() => undefined)
  }

  function remember(patch: UiStatePatch): void {
    state.value = mergeUiState(state.value, patch)
    // The maps are merged key by key on the way to disk, so they gather the
    // same way here: a later table must not drop an earlier one unsent.
    pending = {
      ...pending,
      ...patch,
      ...(patch.autoRefresh || pending?.autoRefresh
        ? { autoRefresh: { ...pending?.autoRefresh, ...patch.autoRefresh } }
        : {}),
      ...(patch.openTabs || pending?.openTabs
        ? { openTabs: { ...pending?.openTabs, ...patch.openTabs } }
        : {})
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, REMEMBER_DELAY_MS)
  }

  /** The interval a table was last left refreshing at; 0 when it was off. */
  function autoRefreshFor(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): number {
    return state.value.autoRefresh[tableMemoryKey(connectionId, database, schema, table)] ?? 0
  }

  function rememberAutoRefresh(
    connectionId: string,
    database: string,
    schema: string,
    table: string,
    ms: number
  ): void {
    remember({ autoRefresh: { [tableMemoryKey(connectionId, database, schema, table)]: ms } })
  }

  /**
   * The tabs last open on a connection, read from disk rather than from what
   * this window loaded: another window may have closed on it since.
   */
  async function savedTabsFor(connectionId: string): Promise<SavedTabs | null> {
    flush()
    try {
      const stored = await api.getUiState()
      return stored.openTabs[connectionId] ?? null
    } catch {
      return state.value.openTabs[connectionId] ?? null
    }
  }

  /** Keeps a connection's open tabs; null forgets them. */
  function rememberTabs(connectionId: string, tabs: SavedTabs | null): void {
    remember({ openTabs: { [connectionId]: tabs } })
  }

  globalThis.window?.addEventListener?.('beforeunload', flush)

  return {
    state,
    load,
    remember,
    flush,
    autoRefreshFor,
    rememberAutoRefresh,
    savedTabsFor,
    rememberTabs
  }
})
