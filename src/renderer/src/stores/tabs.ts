import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  QueryExecutionResult,
  RoutineSource,
  SchemaObjectType,
  TableFilter
} from '@shared/types'
import type { TableCache } from '../lib/tableCache'
import { splitLines } from '../lib/lineDiff'
import { useSettingsStore } from './settings'

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
  /**
   * Whether the selected row's fields are shown beside the results.
   *
   * Per tab, not per window: two tables side by side in a split are being
   * compared, and one of them wanting its fields spelled out says nothing
   * about the other. A new tab opens the way the setting says; from then on
   * the tab is the only thing that answers for it.
   */
  showRowPanel: boolean
  /**
   * The routine this tab is editing, when it was opened from the schema tree,
   * and the stored definition the editor marks its changes against.
   */
  routine?: RoutineSource
  /**
   * How many separate changes the text has against that definition, as the
   * editor last counted them. The tab strip's dot goes by this rather than by
   * `dirty` on a routine's tab: what matters there is whether the text still
   * differs from the server, and reverting every change answers "no" again.
   */
  changeCount?: number
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
  /** As on a query tab: the row panel belongs to the tab showing it. */
  showRowPanel: boolean
  /**
   * How often the rows re-read themselves, in milliseconds; absent or 0 is
   * never, which is how every table opens. Kept on the tab rather than in the
   * view, so a table being watched is still being watched after a trip to
   * another tab — or to its structure — and back.
   */
  autoRefresh?: number
  /**
   * The page the browser last had on screen, so reselecting this tab shows it
   * again straight away and re-reads it behind the rows rather than in front
   * of them. Written `markRaw`, like a query tab's result: it holds a page of
   * rows and nothing here ever mutates it field by field.
   */
  cache?: TableCache
}

export type Tab = QueryTab | TableTab

/**
 * A column of the workspace: its own strip of tabs, one of which is showing.
 *
 * There is one to begin with. Splitting a tab off adds a second, so two tables
 * can be read side by side; emptying it takes it away again. Every tab belongs
 * to exactly one pane.
 */
export interface TabPane {
  id: string
  tabIds: string[]
  activeTabId: string | null
}

let counter = 0
const newId = (): string => `tab-${++counter}`

let paneCounter = 0
const newPaneId = (): string => `pane-${++paneCounter}`

/**
 * Asked before a tab is unmounted; `false` cancels whatever would unmount it.
 *
 * Only a pane's active tab is mounted, so only those can be holding work that
 * leaving would throw away — the view that owns that work registers this
 * against its own tab id and answers for it. Guards are per tab because a split
 * workspace has one mounted view per pane, and a single slot would let the
 * second overwrite the first.
 */
export type LeaveGuard = () => Promise<boolean>

/**
 * Whether a routine's tab holds text the server does not have.
 *
 * Read off the tab itself rather than off its editor: a tab does not have to
 * be on screen to be closed, and its text is kept on it either way. Line
 * endings do not count — a definition stored with CRLF opens in an editor that
 * holds LF, and nothing was changed.
 */
export function hasUnsavedRoutineChanges(tab: Tab | undefined): tab is QueryTab {
  if (tab?.kind !== 'query' || !tab.routine) return false
  return splitLines(tab.sql).join('\n') !== splitLines(tab.routine.baseline).join('\n')
}

/**
 * A routine's tab waiting to hear whether it may close with its changes
 * unsaved. The workspace's dialog answers it: true to close, false to stay.
 */
export interface ClosePrompt {
  tabId: string
  resolve: (close: boolean) => void
}

export const useTabStore = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([])
  const panes = ref<TabPane[]>([{ id: newPaneId(), tabIds: [], activeTabId: null }])
  const focusedPaneId = ref(panes.value[0].id)

  /** Registered by each mounted view, cleared when it unmounts. */
  const guards = new Map<string, LeaveGuard>()

  const closePrompt = ref<ClosePrompt | null>(null)

  /**
   * Asks about every routine among `ids` that would close with its changes
   * unsaved, one at a time, and resolves false as soon as one is to stay.
   *
   * This is not a leave guard. A table's staged edits live in its view, so
   * they are lost the moment it is unmounted and only the mounted tab can be
   * holding any; a routine's text lives on the tab, so switching away from it
   * loses nothing — but closing it does, whether it is on screen or not.
   */
  async function canClose(ids: string[]): Promise<boolean> {
    for (const id of ids) {
      if (!hasUnsavedRoutineChanges(byId(id))) continue
      // One question at a time: a close asked for while another is waiting
      // on its answer is dropped rather than left to wait behind it.
      if (closePrompt.value) return false
      const close = await new Promise<boolean>((resolve) => {
        closePrompt.value = { tabId: id, resolve }
      })
      if (!close) return false
    }
    return true
  }

  function answerClose(close: boolean): void {
    const prompt = closePrompt.value
    closePrompt.value = null
    prompt?.resolve(close)
  }

  function setLeaveGuard(tabId: string, guard: LeaveGuard | null): void {
    if (guard) guards.set(tabId, guard)
    else guards.delete(tabId)
  }

  /** Asks a tab that is about to be unmounted whether it is ready to go. */
  async function canLeave(tabId: string | null | undefined): Promise<boolean> {
    if (!tabId) return true
    const guard = guards.get(tabId)
    return guard ? guard() : true
  }

  const focusedPane = computed(
    () => panes.value.find((pane) => pane.id === focusedPaneId.value) ?? panes.value[0]
  )
  const isSplit = computed(() => panes.value.length > 1)

  const activeId = computed(() => focusedPane.value?.activeTabId ?? null)
  const active = computed(() => tabs.value.find((tab) => tab.id === activeId.value) ?? null)
  const activeQueryTab = computed<QueryTab | null>(() =>
    active.value?.kind === 'query' ? active.value : null
  )
  const activeTableTab = computed<TableTab | null>(() =>
    active.value?.kind === 'table' ? active.value : null
  )

  function paneById(paneId: string): TabPane | undefined {
    return panes.value.find((pane) => pane.id === paneId)
  }

  function paneFor(tabId: string): TabPane | undefined {
    return panes.value.find((pane) => pane.tabIds.includes(tabId))
  }

  function byId(tabId: string): Tab | undefined {
    return tabs.value.find((tab) => tab.id === tabId)
  }

  /** The tabs in a pane, in the order its strip shows them. */
  function tabsIn(paneId: string): Tab[] {
    const pane = paneById(paneId)
    if (!pane) return []
    return pane.tabIds
      .map((id) => byId(id))
      .filter((tab): tab is Tab => Boolean(tab))
  }

  /** The mounted tab of a pane — the one a menu action in it would act on. */
  function activeIdIn(paneId: string): string | null {
    return paneById(paneId)?.activeTabId ?? null
  }

  function focusPane(paneId: string): void {
    if (paneById(paneId)) focusedPaneId.value = paneId
  }

  /**
   * How a tab opens, for the things a tab can then change for itself.
   *
   * Read once, when the tab is made: the setting is the app's default, and a
   * later change to it is for tabs opened after it, not for the ones already
   * on screen.
   */
  function openingDefaults(): { showRowPanel: boolean } {
    return { showRowPanel: useSettingsStore().settings.showRowPanel }
  }

  function addTab(tab: Tab, paneId: string): void {
    const pane = paneById(paneId) ?? panes.value[0]
    tabs.value = [...tabs.value, tab]
    pane.tabIds = [...pane.tabIds, tab.id]
    pane.activeTabId = tab.id
    focusedPaneId.value = pane.id
  }

  // --- opening ---------------------------------------------------------------

  async function openQuery(connectionId: string, sql = '', title = 'Query'): Promise<void> {
    const existingUntitled = tabs.value.find(
      (tab): tab is QueryTab =>
        tab.kind === 'query' &&
        tab.connectionId === connectionId &&
        !tab.dirty &&
        tab.sql === '' &&
        // Emptied, but still the routine's: it would save over it when run.
        !tab.routine
    )
    // Reuse a blank tab rather than piling up empties.
    if (existingUntitled && sql === '') return select(existingUntitled.id)

    // The new tab takes the focused pane's slot, so what is there now goes.
    if (!(await canLeave(focusedPane.value?.activeTabId))) return

    addTab(
      {
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
        statementLine: null,
        ...openingDefaults()
      },
      focusedPaneId.value
    )
  }

  /** Whether a tab is editing this routine, on this connection. */
  function editsRoutine(
    tab: Tab,
    connectionId: string,
    routine: Pick<RoutineSource, 'schema' | 'name' | 'database'>
  ): tab is QueryTab {
    return (
      tab.kind === 'query' &&
      tab.connectionId === connectionId &&
      tab.routine?.schema === routine.schema &&
      tab.routine.name === routine.name &&
      (tab.routine.database ?? '') === (routine.database ?? '')
    )
  }

  /** The tab already editing a routine, if one is open. */
  function routineTab(
    connectionId: string,
    routine: Pick<RoutineSource, 'schema' | 'name' | 'database'>
  ): QueryTab | undefined {
    return tabs.value.find((tab): tab is QueryTab => editsRoutine(tab, connectionId, routine))
  }

  /**
   * Moves what every tab on a routine is measured against, once one of them
   * has saved it.
   *
   * Saved from one tab is saved for all: a second view still holding the old
   * text now differs from the server, and running it would put the old
   * routine back — which is exactly what its marks should then say.
   */
  function storeRoutine(
    connectionId: string,
    routine: Pick<RoutineSource, 'schema' | 'name' | 'database'>,
    baseline: string
  ): void {
    for (const tab of tabs.value) {
      if (!editsRoutine(tab, connectionId, routine) || tab.routine?.baseline === baseline) continue
      update<QueryTab>(tab.id, { routine: { ...tab.routine!, baseline } })
    }
  }

  /**
   * Opens a routine's definition to be edited, its changes marked against it
   * — or shows the tab that already has it, the way a table opens where it
   * stands.
   *
   * One tab per routine, because each carries its own idea of what is stored
   * and of what has been changed since: with two, running one would quietly
   * undo whatever had been saved from the other.
   *
   * `sql` is what the tab opens holding — the definition itself, unless the tab
   * is arriving from another window with its edits in it. Such a tab is never
   * folded into one already open here: its edits exist nowhere else.
   */
  async function openRoutine(
    connectionId: string,
    routine: RoutineSource,
    options: { sql?: string } = {}
  ): Promise<void> {
    const sql = options.sql ?? routine.baseline
    const existing = routineTab(connectionId, routine)
    if (existing && (options.sql === undefined || existing.sql === sql)) {
      return select(existing.id)
    }

    if (!(await canLeave(focusedPane.value?.activeTabId))) return

    addTab(
      {
        id: newId(),
        kind: 'query',
        title: routine.name,
        connectionId,
        sql,
        // A definition is read from the top.
        cursor: 0,
        result: null,
        running: false,
        executionId: null,
        activeResultIndex: 0,
        dirty: false,
        statementLine: null,
        routine: { ...routine },
        changeCount: 0,
        ...openingDefaults()
      },
      focusedPaneId.value
    )
  }

  async function openTable(
    connectionId: string,
    schema: string,
    table: string,
    objectType: SchemaObjectType = 'table',
    view: 'data' | 'structure' = 'data',
    filters?: TableFilter[]
  ): Promise<void> {
    const existing = tabs.value.find(
      (tab): tab is TableTab =>
        tab.kind === 'table' &&
        tab.connectionId === connectionId &&
        tab.schema === schema &&
        tab.table === table
    )
    if (existing) {
      // A table already open is shown where it is, split pane included.
      const pane = paneFor(existing.id)
      if (pane && pane.activeTabId !== existing.id && !(await canLeave(pane.activeTabId))) return
      existing.view = view
      if (filters) {
        existing.filters = filters
        existing.filterRevision += 1
      }
      if (pane) {
        pane.activeTabId = existing.id
        focusedPaneId.value = pane.id
      }
      return
    }

    if (!(await canLeave(focusedPane.value?.activeTabId))) return

    addTab(
      {
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
        filterRevision: filters ? 1 : 0,
        ...openingDefaults()
      },
      focusedPaneId.value
    )
  }

  // --- closing ---------------------------------------------------------------

  /**
   * Resolves false when the tab asked to stay.
   *
   * `moving` is a tab on its way to another window rather than being closed:
   * its view is still unmounted, so staged edits are still asked about, but a
   * routine's text goes with it and has nothing to lose.
   */
  async function close(id: string, options: { moving?: boolean } = {}): Promise<boolean> {
    const pane = paneFor(id)
    if (!pane) return false
    // Only the mounted tab can be holding staged edits.
    if (pane.activeTabId === id && !(await canLeave(id))) return false
    // Any tab can be holding a routine's unsaved changes.
    if (!options.moving && !(await canClose([id]))) return false
    removeTab(id)
    return true
  }

  function removeTab(id: string): void {
    const pane = paneFor(id)
    guards.delete(id)
    tabs.value = tabs.value.filter((tab) => tab.id !== id)
    if (!pane) return

    const index = pane.tabIds.indexOf(id)
    pane.tabIds = pane.tabIds.filter((tabId) => tabId !== id)
    if (pane.activeTabId === id) {
      pane.activeTabId = pane.tabIds[Math.min(index, pane.tabIds.length - 1)] ?? null
    }
    dropEmptyPane(pane.id)
  }

  /** A split pane with nothing left in it stops being a pane. */
  function dropEmptyPane(paneId: string): void {
    const pane = paneById(paneId)
    if (!pane || pane.tabIds.length > 0 || panes.value.length === 1) return
    panes.value = panes.value.filter((entry) => entry.id !== paneId)
    if (focusedPaneId.value === paneId) focusedPaneId.value = panes.value[0].id
  }

  /** Every mounted tab except `keep`, which are the ones that get a say. */
  function mountedExcept(keep: string[]): string[] {
    return panes.value
      .map((pane) => pane.activeTabId)
      .filter((id): id is string => Boolean(id) && !keep.includes(id as string))
  }

  async function closeOthers(id: string): Promise<void> {
    for (const tabId of mountedExcept([id])) {
      if (!(await canLeave(tabId))) return
    }
    if (!(await canClose(tabs.value.filter((tab) => tab.id !== id).map((tab) => tab.id)))) return
    for (const tab of [...tabs.value]) {
      if (tab.id !== id) removeTab(tab.id)
    }
  }

  async function closeAll(): Promise<void> {
    for (const tabId of mountedExcept([])) {
      if (!(await canLeave(tabId))) return
    }
    if (!(await canClose(tabs.value.map((tab) => tab.id)))) return
    for (const tab of [...tabs.value]) removeTab(tab.id)
  }

  /** Disconnecting takes its tabs with it; there is nothing left to save to. */
  function closeForConnection(connectionId: string): void {
    for (const tab of [...tabs.value]) {
      if (tab.connectionId === connectionId) removeTab(tab.id)
    }
  }

  // --- moving around ---------------------------------------------------------

  async function select(id: string): Promise<void> {
    const pane = paneFor(id)
    if (!pane) return
    if (pane.activeTabId === id) {
      focusedPaneId.value = pane.id
      return
    }
    if (!(await canLeave(pane.activeTabId))) return
    pane.activeTabId = id
    focusedPaneId.value = pane.id
  }

  async function cycle(delta: number): Promise<void> {
    const pane = focusedPane.value
    if (!pane || pane.tabIds.length === 0) return
    const index = pane.tabIds.indexOf(pane.activeTabId ?? '')
    const next = (index + delta + pane.tabIds.length) % pane.tabIds.length
    await select(pane.tabIds[next])
  }

  /**
   * Moves a tab into a pane, at a position in its strip.
   *
   * Both ends can lose a mounted view: the tab being moved is remounted in its
   * new pane, and whatever was showing in that pane is replaced — so both are
   * asked before anything moves.
   */
  async function moveToPane(tabId: string, paneId: string, index?: number): Promise<void> {
    const from = paneFor(tabId)
    const to = paneById(paneId)
    if (!from || !to) return

    if (from.id === to.id) {
      reorder(tabId, index ?? from.tabIds.length)
      focusedPaneId.value = to.id
      return
    }

    if (from.activeTabId === tabId && !(await canLeave(tabId))) return
    if (to.activeTabId && to.activeTabId !== tabId && !(await canLeave(to.activeTabId))) return

    const wasActive = from.activeTabId === tabId
    const position = from.tabIds.indexOf(tabId)
    from.tabIds = from.tabIds.filter((id) => id !== tabId)
    if (wasActive) {
      from.activeTabId = from.tabIds[Math.min(position, from.tabIds.length - 1)] ?? null
    }

    const at = Math.max(0, Math.min(index ?? to.tabIds.length, to.tabIds.length))
    to.tabIds = [...to.tabIds.slice(0, at), tabId, ...to.tabIds.slice(at)]
    to.activeTabId = tabId
    focusedPaneId.value = to.id

    dropEmptyPane(from.id)
  }

  /** Drag within one strip: nothing is unmounted, so nothing is asked. */
  function reorder(tabId: string, index: number): void {
    const pane = paneFor(tabId)
    if (!pane) return
    const from = pane.tabIds.indexOf(tabId)
    const without = pane.tabIds.filter((id) => id !== tabId)
    // `index` counts the gaps in the strip as it is drawn, which still has the
    // dragged tab in it; lifting the tab out shifts every gap after it left.
    const wanted = from >= 0 && index > from ? index - 1 : index
    const at = Math.max(0, Math.min(wanted, without.length))
    pane.tabIds = [...without.slice(0, at), tabId, ...without.slice(at)]
  }

  // --- splitting -------------------------------------------------------------

  /**
   * A second view of the same thing: a new tab, none of the work the first one
   * was holding.
   *
   * Its cached page does come along. A query tab's result cannot — nobody ran
   * it in the new tab — but a table tab loads the moment it opens, so the copy
   * is about to ask for those very rows and can just as well show them while
   * it waits.
   */
  function copyOf(tab: Tab): Tab {
    if (tab.kind === 'query') {
      return {
        ...tab,
        id: newId(),
        result: null,
        running: false,
        executionId: null,
        savedQueryId: tab.savedQueryId,
        dirty: tab.dirty
      }
    }
    return {
      ...tab,
      id: newId(),
      pendingEdits: 0,
      filters: tab.filters ? tab.filters.map((filter) => ({ ...filter })) : undefined
    }
  }

  /**
   * Puts a tab in a pane beside the one it is in.
   *
   * Splitting the only tab in a pane would empty that pane, so what opens
   * beside it is a second view of the same table or query instead — which is
   * what "show me these side by side" means when there is only one of them.
   */
  async function splitTab(tabId: string): Promise<void> {
    const tab = byId(tabId)
    const from = paneFor(tabId)
    if (!tab || !from) return

    const existing = panes.value.find((pane) => pane.id !== from.id)
    if (existing) {
      // Already split: the second pane is where it goes, not a third one.
      if (from.tabIds.length === 1) {
        addTab(copyOf(tab), existing.id)
        return
      }
      await moveToPane(tabId, existing.id)
      return
    }

    const pane: TabPane = { id: newPaneId(), tabIds: [], activeTabId: null }
    panes.value = [...panes.value, pane]
    if (from.tabIds.length === 1) {
      addTab(copyOf(tab), pane.id)
      return
    }
    await moveToPane(tabId, pane.id)
  }

  /**
   * Folds the split away, keeping every tab in the pane that remains.
   *
   * Both mounted views go: the one being folded in is remounted in the pane
   * that stays, and whatever was showing there is replaced by it — so both are
   * asked before anything moves.
   */
  async function closeSplit(): Promise<void> {
    if (panes.value.length < 2) return
    const [first, second] = panes.value
    const keep = second.activeTabId
    if (keep && !(await canLeave(keep))) return
    if (first.activeTabId && first.activeTabId !== keep && !(await canLeave(first.activeTabId))) {
      return
    }

    for (const tabId of [...second.tabIds]) {
      first.tabIds = [...first.tabIds, tabId]
    }
    second.tabIds = []
    panes.value = [first]
    focusedPaneId.value = first.id
    if (keep) first.activeTabId = keep
    else if (!first.activeTabId) first.activeTabId = first.tabIds[0] ?? null
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
    panes,
    focusedPaneId,
    focusedPane,
    isSplit,
    activeId,
    active,
    activeQueryTab,
    activeTableTab,
    tabsIn,
    activeIdIn,
    paneFor,
    focusPane,
    openQuery,
    openRoutine,
    routineTab,
    storeRoutine,
    openTable,
    close,
    closeOthers,
    closeAll,
    closeForConnection,
    select,
    cycle,
    moveToPane,
    reorder,
    splitTab,
    closeSplit,
    update,
    setLeaveGuard,
    closePrompt,
    answerClose
  }
})
