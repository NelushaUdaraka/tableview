import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  QueryExecutionResult,
  RoutineSource,
  SchemaObjectType,
  SessionEvent,
  SessionState,
  TableFilter
} from '@shared/types'
import type { SavedTab, SavedTabs } from '@shared/uiState'
import type { TableCache } from '../lib/tableCache'
import { transactionOpen } from '@shared/sessions'
import { splitLines } from '../lib/lineDiff'
import { endSession, stopRun } from '../lib/tabSessions'
import { useBusyStore } from './busy'
import { useSettingsStore } from './settings'
import { useToastStore } from './toasts'

export interface RevealLine {
  line: number
  find?: { text: string; matchCase?: boolean; wholeWord?: boolean }
}

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
   * A line to bring into view once the editor is on screen, and the text on
   * it to select: where a search result was clicked. The view takes it and
   * clears it, so it is never kept or carried to another window.
   */
  revealLine?: RevealLine
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
  /**
   * The tab's own session as the main process last reported it: absent before
   * the tab first runs anything, and once the session is closed or lost.
   */
  session?: SessionState
  /**
   * What a lost session had, said once above the results; the next run
   * clears it.
   */
  sessionLost?: SessionState
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
   * never, which is how a table opens unless it was left refreshing (the
   * interval is remembered per table, see `stores/uiState.ts`). Kept on the
   * tab rather than in the view, so a table being watched is still being
   * watched after a trip to another tab — or to its structure — and back.
   */
  autoRefresh?: number
  /**
   * Columns taken out of the grid, by name; absent or empty shows them all,
   * which is how every table opens. Kept on the tab for the same reason as the
   * interval, and by name rather than position so a page read again — or a
   * table altered under it — keeps the same columns out of view.
   */
  hiddenColumns?: string[]
  /**
   * The page the browser last had on screen, so reselecting this tab shows it
   * again straight away and re-reads it behind the rows rather than in front
   * of them. Written `markRaw`, like a query tab's result: it holds a page of
   * rows and nothing here ever mutates it field by field.
   */
  cache?: TableCache
}

/**
 * The server's sessions and what they are running: the activity monitor. One
 * per connection in a window, since they would all show the same server.
 */
export interface ActivityTab {
  id: string
  kind: 'activity'
  title: string
  connectionId: string
  /** Kept for the shape every tab shares; the monitor has no row panel. */
  showRowPanel: boolean
  /** How often it reads the server again, in milliseconds; absent or 0 is never. */
  autoRefresh?: number
  /** List sleeping sessions that hold nothing open, too. */
  showIdle?: boolean
}

export type Tab = QueryTab | TableTab | ActivityTab

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
 * Why a tab's work is about to go — which is what its prompt should say.
 *
 * `leave` is a view being unmounted while its tab stays: another tab picked,
 * the tab moved to the other pane or to another window. The rest take the tab
 * with them: closing it, disconnecting, closing the window, quitting.
 */
export type LeaveReason = 'leave' | 'close' | 'disconnect' | 'close-window' | 'quit'

/** The reasons a tab itself goes, which is all a routine's changes care about. */
export type CloseReason = Exclude<LeaveReason, 'leave'>

/**
 * Asked before a tab is unmounted; `false` cancels whatever would unmount it.
 *
 * Only a pane's active tab is mounted, so only those can be holding work that
 * leaving would throw away — the view that owns that work registers this
 * against its own tab id and answers for it. Guards are per tab because a split
 * workspace has one mounted view per pane, and a single slot would let the
 * second overwrite the first.
 */
export type LeaveGuard = (reason: LeaveReason) => Promise<boolean>

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
  reason: CloseReason
  resolve: (close: boolean) => void
}

/** What would end a tab's session, which is what its question says. */
export type TransactionReason = CloseReason | 'move'

/**
 * A query tab whose session is about to end with a transaction open in it,
 * waiting to hear whether it may. The workspace's dialog commits or rolls it
 * back and answers true, or answers false to keep everything as it was.
 */
export interface TransactionPrompt {
  tabId: string
  reason: TransactionReason
  /** Its query is running inside a transaction that was open before the run. */
  running: boolean
  /** Its query was stopped to end the session, and left a transaction open. */
  stopped: boolean
  resolve: (proceed: boolean) => void
}

export const useTabStore = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([])
  const panes = ref<TabPane[]>([{ id: newPaneId(), tabIds: [], activeTabId: null }])
  const focusedPaneId = ref(panes.value[0].id)

  /** Registered by each mounted view, cleared when it unmounts. */
  const guards = new Map<string, LeaveGuard>()

  const closePrompt = ref<ClosePrompt | null>(null)

  const transactionPrompt = ref<TransactionPrompt | null>(null)

  /**
   * Asks about every routine among `ids` that would close with its changes
   * unsaved, one at a time, and resolves false as soon as one is to stay.
   *
   * This is not a leave guard. A table's staged edits live in its view, so
   * they are lost the moment it is unmounted and only the mounted tab can be
   * holding any; a routine's text lives on the tab, so switching away from it
   * loses nothing — but closing it does, whether it is on screen or not.
   */
  async function canClose(ids: string[], reason: CloseReason = 'close'): Promise<boolean> {
    for (const id of ids) {
      if (!hasUnsavedRoutineChanges(byId(id))) continue
      // One question at a time: a close asked for while another is waiting
      // on its answer is dropped rather than left to wait behind it.
      if (closePrompt.value) return false
      const close = await new Promise<boolean>((resolve) => {
        closePrompt.value = { tabId: id, reason, resolve }
      })
      if (!close) return false
    }
    return true
  }

  /**
   * Asks every tab among `ids` that has work to lose if they all go: the
   * mounted ones about staged edits first, then every routine about unsaved
   * changes. Resolves false as soon as one of them is to stay.
   */
  async function canDiscard(ids: string[], reason: CloseReason): Promise<boolean> {
    for (const tabId of mountedExcept([])) {
      if (ids.includes(tabId) && !(await canLeave(tabId, reason))) return false
    }
    if (!(await canClose(ids, reason))) return false
    return canEndSessions(ids, reason)
  }

  /** Asks about one tab's transaction; false straight away while another question waits. */
  async function askTransaction(
    tabId: string,
    reason: TransactionReason,
    situation: { running: boolean; stopped: boolean }
  ): Promise<boolean> {
    // One question at a time: an end asked for while another is waiting on
    // its answer is dropped rather than left to wait behind it.
    if (transactionPrompt.value) return false
    return new Promise<boolean>((resolve) => {
      transactionPrompt.value = { tabId, reason, ...situation, resolve }
    })
  }

  /** Whether the query tab `id` is running right now, read afresh. */
  function isRunning(id: string): boolean {
    const tab = byId(id)
    return tab?.kind === 'query' && tab.running
  }

  /**
   * Asks every query tab among `ids` whose session would end with a
   * transaction open in it, one at a time, and resolves false as soon as one
   * is to stay.
   *
   * A tab still running is stopped first, the way its Cancel button does:
   * nothing can be committed or rolled back on a session while a run holds
   * it, and only once it has stopped is it known whether the run left a
   * transaction open. A run inside a transaction that was already open is
   * asked about before it is stopped. A query that will not stop in time is
   * not waited on for ever: its session ends with the tab, and the server
   * undoes what it had not finished.
   */
  async function canEndSessions(ids: string[], reason: TransactionReason): Promise<boolean> {
    for (const id of ids) {
      const tab = byId(id)
      if (tab?.kind !== 'query') continue

      if (tab.running) {
        if (transactionOpen(tab.session)) {
          if (!(await askTransaction(id, reason, { running: true, stopped: false }))) return false
          continue
        }
        const busy = useBusyStore()
        useToastStore().info(`Stopping the query in ${tab.title}…`)
        busy.begin()
        let stopped = false
        try {
          stopped = await stopRun(tab, () => isRunning(id))
        } finally {
          busy.end()
        }
        if (!stopped) continue
        const after = byId(id)
        if (after?.kind === 'query' && transactionOpen(after.session)) {
          if (!(await askTransaction(id, reason, { running: false, stopped: true }))) return false
        }
        continue
      }

      if (transactionOpen(tab.session)) {
        if (!(await askTransaction(id, reason, { running: false, stopped: false }))) return false
      }
    }
    return true
  }

  function answerTransaction(proceed: boolean): void {
    const prompt = transactionPrompt.value
    transactionPrompt.value = null
    prompt?.resolve(proceed)
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
  async function canLeave(
    tabId: string | null | undefined,
    reason: LeaveReason = 'leave'
  ): Promise<boolean> {
    if (!tabId) return true
    const guard = guards.get(tabId)
    return guard ? guard(reason) : true
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

  /**
   * Always a new tab, even with a blank one already open: `+` and Ctrl+T are
   * how a second scratch query gets started beside the first.
   *
   * A saved query opened by `savedQueryId` is the exception: it is tied to
   * that saved query, so saving the tab saves it, and one already open on
   * this connection is shown where it is rather than opened twice.
   */
  async function openQuery(
    connectionId: string,
    sql = '',
    title = 'Query',
    options: { savedQueryId?: string } = {}
  ): Promise<void> {
    if (options.savedQueryId) {
      const open = tabs.value.find(
        (tab) =>
          tab.kind === 'query' &&
          tab.connectionId === connectionId &&
          tab.savedQueryId === options.savedQueryId
      )
      if (open) return select(open.id)
    }

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
        ...(options.savedQueryId ? { savedQueryId: options.savedQueryId } : {}),
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
      if (!(await setTableView(existing.id, view))) return
      if (filters) {
        // Read again: answering a question can have replaced the tab object.
        const current = byId(existing.id) as TableTab
        update<TableTab>(existing.id, { filters, filterRevision: current.filterRevision + 1 })
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

  /**
   * Opens the activity monitor for a connection — or shows the one already
   * open, wherever it is: two would only show the same server twice.
   */
  async function openActivity(connectionId: string): Promise<void> {
    const existing = tabs.value.find(
      (tab) => tab.kind === 'activity' && tab.connectionId === connectionId
    )
    if (existing) return select(existing.id)
    if (!(await canLeave(focusedPane.value?.activeTabId))) return
    addTab(
      {
        id: newId(),
        kind: 'activity',
        title: 'Activity',
        connectionId,
        ...openingDefaults()
      },
      focusedPaneId.value
    )
  }

  /**
   * Shows a table tab's rows or its structure. Resolves false when the tab
   * asked to stay where it was.
   *
   * The rows' view is where staged edits live, and the structure replaces
   * it, so leaving the rows on screen asks first — as leaving the tab would.
   * A tab that is not on screen has no view, and nothing to lose.
   */
  async function setTableView(tabId: string, view: 'data' | 'structure'): Promise<boolean> {
    const tab = byId(tabId)
    if (tab?.kind !== 'table' || tab.view === view) return true
    const onScreen = paneFor(tabId)?.activeTabId === tabId
    if (tab.view === 'data' && onScreen && !(await canLeave(tabId))) return false
    update<TableTab>(tabId, { view })
    return true
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
    const leaving = options.moving ? 'leave' : 'close'
    if (pane.activeTabId === id && !(await canLeave(id, leaving))) return false
    // Any tab can be holding a routine's unsaved changes.
    if (!options.moving && !(await canClose([id]))) return false
    // A session cannot go with a tab to another window, so moving asks too.
    if (!(await canEndSessions([id], options.moving ? 'move' : 'close'))) return false
    removeTab(id)
    return true
  }

  function removeTab(id: string): void {
    const pane = paneFor(id)
    const leaving = byId(id)
    // A query tab takes its session with it — one still opening for its
    // first run too; whatever was open in it has been asked about by now.
    if (leaving?.kind === 'query') void endSession(leaving)
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
    const others = tabs.value.filter((tab) => tab.id !== id).map((tab) => tab.id)
    if (!(await canDiscard(others, 'close'))) return
    for (const tab of [...tabs.value]) {
      if (tab.id !== id) removeTab(tab.id)
    }
  }

  async function closeAll(): Promise<void> {
    if (!(await canDiscard(tabs.value.map((tab) => tab.id), 'close'))) return
    for (const tab of [...tabs.value]) removeTab(tab.id)
  }

  /** Takes a connection's tabs away, asking nothing; see `closeConnection`. */
  function closeForConnection(connectionId: string): void {
    for (const tab of [...tabs.value]) {
      if (tab.connectionId === connectionId) removeTab(tab.id)
    }
  }

  /**
   * Closes a connection's tabs once their unsaved work has been answered for
   * — which is what disconnecting does. Resolves false when one is to stay,
   * and then nothing closes.
   */
  async function closeConnection(connectionId: string): Promise<boolean> {
    const ids = tabs.value.filter((tab) => tab.connectionId === connectionId).map((tab) => tab.id)
    if (!(await canDiscard(ids, 'disconnect'))) return false
    closeForConnection(connectionId)
    return true
  }

  /**
   * Whether this window may close, or the app quit: every tab with work to
   * lose is asked, as closing them all would ask them. Nothing is closed here;
   * the window takes its tabs with it.
   */
  function canCloseWindow(reason: 'close-window' | 'quit'): Promise<boolean> {
    return canDiscard(
      tabs.value.map((tab) => tab.id),
      reason
    )
  }

  /**
   * Whether any tab holds work that closing the window would lose: a table's
   * staged edits, a routine's unsaved changes, or a query tab's open
   * transaction — or a query still running, which may be opening one. The
   * main process holds a window's close while this is true, and asks.
   */
  const hasUnsavedWork = computed(() =>
    tabs.value.some((tab) =>
      tab.kind === 'table'
        ? tab.pendingEdits > 0
        : tab.kind === 'query'
          ? // A running query may be opening a transaction this window has not
            // seen yet, so it is stopped and looked at before the window goes.
            tab.running || transactionOpen(tab.session) || hasUnsavedRoutineChanges(tab)
          : false
    )
  )

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
        dirty: tab.dirty,
        // A session belongs to one tab: the copy opens its own when it runs.
        session: undefined,
        sessionLost: undefined
      }
    }
    if (tab.kind === 'activity') return { ...tab, id: newId() }
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
  /**
   * A tab's session moved with the sidebar's database, or was lost, with no
   * run of the tab's to say so. Meant for one tab on one connection.
   */
  function applySessionEvent(event: SessionEvent): void {
    const tab = byId(event.sessionId)
    if (tab?.kind !== 'query' || tab.connectionId !== event.connectionId) return
    if (event.state) {
      update<QueryTab>(tab.id, { session: event.state })
    } else {
      update<QueryTab>(tab.id, { session: undefined, sessionLost: event.lost ?? tab.sessionLost })
    }
  }

  function update<T extends Tab>(id: string, patch: Partial<T>): void {
    const current = tabs.value.find((tab) => tab.id === id) as T | undefined
    if (!current) return
    const changed = (Object.keys(patch) as (keyof T)[]).some(
      (key) => current[key] !== patch[key]
    )
    if (!changed) return
    tabs.value = tabs.value.map((tab) => (tab.id === id ? ({ ...tab, ...patch } as Tab) : tab))
  }

  // --- across restarts -------------------------------------------------------

  function savedTabFrom(tab: Tab): SavedTab {
    const common = { title: tab.title, showRowPanel: tab.showRowPanel }
    if (tab.kind === 'activity') return { kind: 'activity', ...common }
    if (tab.kind === 'table') {
      return {
        kind: 'table',
        ...common,
        schema: tab.schema,
        table: tab.table,
        objectType: tab.objectType,
        view: tab.view,
        ...(tab.hiddenColumns?.length ? { hiddenColumns: [...tab.hiddenColumns] } : {})
      }
    }
    return {
      kind: 'query',
      ...common,
      sql: tab.sql,
      cursor: tab.cursor,
      ...(tab.savedQueryId ? { savedQueryId: tab.savedQueryId } : {}),
      ...(tab.dirty ? { dirty: true } : {}),
      ...(tab.routine ? { routine: { ...tab.routine } } : {})
    }
  }

  /**
   * The window's tabs on one connection, as they would be reopened: in their
   * panes and order, with the tab each pane was showing. Null when there are
   * none, which is what a window whose tabs were all closed should reopen to.
   */
  function snapshot(connectionId: string): SavedTabs | null {
    const saved = panes.value
      .map((pane) => {
        const ids = pane.tabIds.filter((id) => byId(id)?.connectionId === connectionId)
        return {
          tabs: ids.map((id) => savedTabFrom(byId(id)!)),
          active: Math.max(0, ids.indexOf(pane.activeTabId ?? ''))
        }
      })
      .filter((pane) => pane.tabs.length > 0)
    if (saved.length === 0) return null
    const focusedIndex = panes.value.findIndex((pane) => pane.id === focusedPaneId.value)
    return { panes: saved, focused: Math.max(0, Math.min(focusedIndex, saved.length - 1)) }
  }

  function tabFromSaved(saved: SavedTab, connectionId: string): Tab {
    const showRowPanel = saved.showRowPanel ?? openingDefaults().showRowPanel
    if (saved.kind === 'activity') {
      return { id: newId(), kind: 'activity', title: saved.title || 'Activity', connectionId, showRowPanel }
    }
    if (saved.kind === 'table') {
      return {
        id: newId(),
        kind: 'table',
        title: saved.title,
        connectionId,
        schema: saved.schema!,
        table: saved.table!,
        objectType: saved.objectType ?? 'table',
        view: saved.view ?? 'data',
        pendingEdits: 0,
        filterRevision: 0,
        showRowPanel,
        ...(saved.hiddenColumns?.length ? { hiddenColumns: [...saved.hiddenColumns] } : {})
      }
    }
    // A routine reopens at its stored definition: closing the app asked about
    // its unsaved changes, and anything said then to be lost stays lost.
    const sql = saved.routine ? saved.routine.baseline : (saved.sql ?? '')
    return {
      id: newId(),
      kind: 'query',
      title: saved.title,
      connectionId,
      sql,
      cursor: saved.routine ? 0 : Math.min(saved.cursor ?? sql.length, sql.length),
      result: null,
      running: false,
      executionId: null,
      activeResultIndex: 0,
      dirty: !saved.routine && saved.dirty === true,
      statementLine: null,
      showRowPanel,
      ...(saved.savedQueryId ? { savedQueryId: saved.savedQueryId } : {}),
      ...(saved.routine ? { routine: { ...saved.routine }, changeCount: 0 } : {})
    }
  }

  /**
   * Reopens tabs saved by `snapshot`, panes and all. Only into a window with
   * no tabs yet: it sets the layout outright, and nothing is mounted to ask.
   */
  function restore(connectionId: string, saved: SavedTabs): boolean {
    if (tabs.value.length > 0 || saved.panes.length === 0) return false
    const restored: Tab[] = []
    const layout: TabPane[] = saved.panes.slice(0, 2).map((pane) => {
      const opened = pane.tabs.map((entry) => tabFromSaved(entry, connectionId))
      restored.push(...opened)
      return {
        id: newPaneId(),
        tabIds: opened.map((tab) => tab.id),
        activeTabId: opened[Math.min(pane.active, opened.length - 1)]?.id ?? null
      }
    })
    tabs.value = restored
    panes.value = layout
    focusedPaneId.value = layout[Math.min(saved.focused, layout.length - 1)].id
    return true
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
    openActivity,
    setTableView,
    close,
    closeOthers,
    closeAll,
    closeForConnection,
    closeConnection,
    canCloseWindow,
    hasUnsavedWork,
    select,
    cycle,
    moveToPane,
    reorder,
    splitTab,
    closeSplit,
    update,
    applySessionEvent,
    setLeaveGuard,
    closePrompt,
    answerClose,
    transactionPrompt,
    answerTransaction,
    snapshot,
    restore
  }
})
