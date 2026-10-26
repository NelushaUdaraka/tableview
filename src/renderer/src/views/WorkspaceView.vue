<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DetachedTab } from '@shared/ipc'
import type {
  CellValue,
  ColumnMeta,
  ConnectionStatus,
  SchemaObjectType,
  TableFilter
} from '@shared/types'
import {
  buildCreateTableDdl,
  buildDeleteTemplate,
  buildInsertTemplate,
  buildSelectTemplate,
  buildUpdateTemplate
} from '@shared/sql/builder'
import { asCreateOrAlter } from '@shared/sql/statements'
import AppSidebar from '../components/AppSidebar.vue'
import SplitPane from '../components/SplitPane.vue'
import StatusBar from '../components/StatusBar.vue'
import ExportDialog from '../components/ExportDialog.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import ShortcutsDialog from '../components/ShortcutsDialog.vue'
import UnsavedRoutineDialog from '../components/UnsavedRoutineDialog.vue'
import OpenTransactionDialog from '../components/OpenTransactionDialog.vue'
import QuickOpen from '../components/QuickOpen.vue'
import TabPaneView from './TabPaneView.vue'
import { useConnectionStore } from '../stores/connections'
import { useReadOnlyStore } from '../stores/readOnly'
import { useSchemaStore } from '../stores/schema'
import { useSettingsStore } from '../stores/settings'
import { useTabStore, type QueryTab, type RevealLine } from '../stores/tabs'
import { useToastStore } from '../stores/toasts'
import { useUiStateStore } from '../stores/uiState'
import { useLibraryStore } from '../stores/library'
import { onMenuAction } from '../lib/menuBus'
import { exportConnections, importConnections } from '../lib/connectionTransfer'
import { detachedTabFrom, openTabFrom } from '../lib/detach'
import {
  objectKey,
  queryKey,
  routineKey,
  touchRecent,
  type QuickOpenItem
} from '../lib/quickOpen'
import { api } from '../lib/api'

type PaneView = InstanceType<typeof TabPaneView>

const props = withDefaults(
  defineProps<{
    /** Set when the window was opened to hold one tab dragged out of another. */
    detached?: boolean
  }>(),
  { detached: false }
)

const connections = useConnectionStore()
const readOnly = useReadOnlyStore()
const schema = useSchemaStore()
const settings = useSettingsStore()
const tabs = useTabStore()
const toasts = useToastStore()
const uiState = useUiStateStore()
const library = useLibraryStore()

const sidebar = ref<InstanceType<typeof AppSidebar> | null>(null)

/**
 * The two pane views, and which of them a menu action goes to.
 *
 * There are at most two panes and they keep their positions, so the views are
 * held by position rather than by pane id — a ref bound to an id would have to
 * name a pane that, by the time the ref is cleared, has already gone.
 */
const primaryPane = ref<PaneView | null>(null)
const secondaryPane = ref<PaneView | null>(null)

const focusedView = computed<PaneView | null>(() =>
  tabs.panes[1] && tabs.focusedPaneId === tabs.panes[1].id
    ? secondaryPane.value
    : primaryPane.value
)

const mainArea = ref<HTMLElement | null>(null)
/**
 * Width of the sidebar. In the default 1440px window, 320px still leaves a
 * table's toolbar room for its labels with edits staged; much wider and the
 * toolbar would lose them. After that, it is whatever the last drag left.
 */
const sidebarWidth = ref(uiState.state.sidebarWidth)
watch(sidebarWidth, (width) => uiState.remember({ sidebarWidth: width }))
/** Width of the second pane when the workspace is split. */
const splitWidth = ref(640)

/**
 * A split starts even.
 *
 * The remembered width is whatever the last drag left, which on a narrower
 * window can be most of it — and a pane opening at that width would leave the
 * other one a sliver. Half of what there is to share is a fair opening bid;
 * the divider is there for anything else.
 */
watch(
  () => tabs.isSplit,
  (split) => {
    const width = mainArea.value?.clientWidth ?? 0
    if (split && width > 0) splitWidth.value = Math.round(width / 2)
  }
)
/**
 * A window opened for one dragged-out tab opens as that tab and nothing else.
 *
 * The schema tree belongs to the workspace, not to the tab, so it stays out of
 * the way — and out of the document, since a tree nobody is looking at is a
 * few thousand nodes of nothing. `Ctrl+B` brings it in, and it stays from then
 * on: putting it away again should not rebuild it.
 *
 * A full window opens with the tree out or away as the last one was left; a
 * one-tab window says nothing about that, so it neither follows nor sets it.
 */
const sidebarCollapsed = ref(props.detached || uiState.state.sidebarCollapsed)
const sidebarMounted = ref(!sidebarCollapsed.value)
watch(sidebarCollapsed, (collapsed) => {
  if (!collapsed) sidebarMounted.value = true
  if (!props.detached) uiState.remember({ sidebarCollapsed: collapsed })
})

const showSettings = ref(false)
const showShortcuts = ref(false)
const showQuickOpen = ref(false)

/**
 * What was on screen lately, most recent first, as quick open's keys — so
 * the table you were just in is the first thing it offers. Kept for this
 * window while it stays on this connection; it is not worth a file.
 */
const recent = ref<string[]>([])
watch(
  () => {
    const tab = tabs.active
    if (!tab || tab.kind === 'activity') return null
    if (tab.kind === 'table') return objectKey(tab.schema, tab.table)
    if (tab.routine) return routineKey(tab.routine.schema, tab.routine.name)
    return tab.savedQueryId ? queryKey(tab.savedQueryId) : null
  },
  (key) => {
    if (key) recent.value = touchRecent(recent.value, key)
  }
)

/** Opens what quick open picked: a table's rows or structure, a routine, a saved query. */
function openPicked(item: QuickOpenItem, structure: boolean): void {
  showQuickOpen.value = false
  if (!item.schema) {
    const saved = library.savedQueries.find((query) => query.id === item.savedQueryId)
    if (saved && connectionId.value) {
      void tabs.openQuery(connectionId.value, saved.sql, saved.name, { savedQueryId: saved.id })
    }
    return
  }
  if (item.kind === 'procedure' || item.kind === 'function') {
    void openRoutine(item.schema, item.name)
    return
  }
  openTable(item.schema, item.name, item.objectType ?? 'table', structure ? 'structure' : 'data')
}
const exportPayload = ref<{ columns: ColumnMeta[]; rows: CellValue[][]; name?: string } | null>(
  null
)

const connectionId = computed(() => connections.activeId ?? '')

function openTable(
  schemaName: string,
  table: string,
  type: SchemaObjectType,
  view: 'data' | 'structure' = 'data'
): void {
  if (!connectionId.value) return
  tabs.openTable(connectionId.value, schemaName, table, type, view)
}

/** Following a foreign key: the referenced table, filtered to the row it names. */
function openRelated(schemaName: string, table: string, filters: TableFilter[]): void {
  if (!connectionId.value) return
  tabs.openTable(connectionId.value, schemaName, table, 'table', 'data', filters)
}

function openSql(sql: string, title = 'Query'): void {
  if (!connectionId.value) return
  tabs.openQuery(connectionId.value, sql, title)
}

function newQueryTab(): void {
  if (!connectionId.value) return
  tabs.openQuery(connectionId.value)
}

/**
 * Opens a routine from the tree as its definition, ready to be edited.
 *
 * Opened as `CREATE OR ALTER`, so running the tab saves an edit back to the
 * database instead of failing on the object that is already there — and kept
 * as what is stored, so the editor can mark every change made to it. A routine
 * that is already open is shown where it is, without asking the server again.
 *
 * `reveal` is a line to scroll to, from a search result. Views and triggers
 * open the same way: their definitions are edited like a routine's.
 */
async function openRoutine(schemaName: string, name: string, reveal?: RevealLine): Promise<void> {
  const id = connectionId.value
  if (!id) return
  const database = connections.activeStatus?.currentDatabase || undefined
  const routine = { schema: schemaName, name, database }
  const showLine = (): void => {
    const tab = tabs.routineTab(id, routine)
    if (reveal && tab) tabs.update<QueryTab>(tab.id, { revealLine: { ...reveal } })
  }
  const open = tabs.routineTab(id, routine)
  if (open) {
    await tabs.select(open.id)
    showLine()
    return
  }

  try {
    const definition = await api.getObjectDefinition(id, schemaName, name)
    if (!definition) {
      // Encrypted, or out of this login's sight: nothing to edit or compare.
      openSql('-- no definition available', name)
      return
    }
    const type = schema.routines.find(
      (routine) => routine.schema === schemaName && routine.name === name
    )?.type
    await tabs.openRoutine(id, {
      schema: schemaName,
      name,
      type,
      database,
      baseline: asCreateOrAlter(definition)
    })
    showLine()
  } catch (error) {
    toasts.fromError(`Could not read the definition of ${schemaName}.${name}`, error)
  }
}

/** Sidebar "generate statement" actions. */
async function generate(kind: string, schemaName: string, table: string): Promise<void> {
  if (!connectionId.value) return
  try {
    const structure = await schema.getStructure(connectionId.value, schemaName, table)
    const builders: Record<string, () => string> = {
      select: () => buildSelectTemplate(structure),
      insert: () => buildInsertTemplate(structure),
      update: () => buildUpdateTemplate(structure),
      delete: () => buildDeleteTemplate(structure),
      ddl: () => buildCreateTableDdl(structure)
    }
    const build = builders[kind]
    if (!build) return
    openSql(build(), `${table} ${kind}`)
  } catch (error) {
    toasts.fromError('Could not generate that statement', error)
  }
}

/**
 * Hands a tab to another window, and closes it here.
 *
 * Windows do not share connections, so the window that takes it opens its own;
 * what travels is only what it takes to open the same thing again. The tab is
 * asked before it goes — leaving unmounts its view, and staged edits would go
 * with it — and put back if nothing took it.
 */
async function moveTabOut(
  tabId: string,
  hand: (payload: DetachedTab) => Promise<unknown>,
  failure: string
): Promise<void> {
  const tab = tabs.tabs.find((entry) => entry.id === tabId)
  if (!tab) return

  const payload = detachedTabFrom(tab)

  // Moving, not closing: a routine's text travels with it, so only staged
  // edits — which do not — are asked about.
  if (!(await tabs.close(tabId, { moving: true }))) return

  try {
    await hand(payload)
    closeIfEmptied()
  } catch (error) {
    toasts.fromError(failure, error)
    // Put it back rather than losing it to a window that never took it.
    void openTabFrom(payload)
  }
}

/** Opens a tab in a window of its own — the menu's "move to a new window". */
async function detachTab(tabId: string, position: { x: number; y: number }): Promise<void> {
  await moveTabOut(
    tabId,
    (payload) => api.detachTab({ tab: payload, position }),
    'Could not open a window for that tab'
  )
}

/**
 * Gives up a tab let go somewhere outside this window.
 *
 * Where that was is not something a renderer can see — a drag stays inside the
 * document it started in — so the pointer's last position goes to the main
 * process, which knows where the windows are: one under it takes the tab, and
 * with nothing there the tab gets a window of its own. Dragging a tab back
 * into the window it came from is the same gesture in reverse, which is the
 * whole point of asking rather than always opening a window.
 */
async function dropTab(tabId: string, point: { x: number; y: number }): Promise<void> {
  await moveTabOut(
    tabId,
    (payload) => api.dropTab({ tab: payload, point }),
    'Could not move that tab to another window'
  )
}

/**
 * A window opened for one dragged-out tab goes when that tab leaves again.
 *
 * Such a window *is* the tab: once it has been dragged back into another
 * window, what is left is an empty frame nobody asked for. A window opened in
 * its own right stays — it has a schema tree to open something else from.
 */
function closeIfEmptied(): void {
  if (props.detached && tabs.tabs.length === 0) void api.closeWindow()
}

/**
 * Disconnecting takes every tab on the connection with it, so staged edits
 * and a routine's unsaved changes are asked about first — the same questions
 * closing those tabs one by one would ask. Any answer of Cancel keeps the
 * connection, and every tab, as they were.
 */
async function disconnect(): Promise<void> {
  const id = connections.activeId
  if (!id) return
  // The tabs go because the connection does, not because they were closed:
  // what was open is what connecting again should bring back.
  keepingTabs = false
  if (!(await tabs.closeConnection(id))) {
    keepingTabs = true
    return
  }
  schema.reset()
  await connections.disconnect(id)
}

// --- menu + keyboard --------------------------------------------------------

function handleAction(action: string): void {
  switch (action) {
    case 'tab:new-query':
      newQueryTab()
      break
    case 'connections:import':
      void importConnections()
      break
    case 'connections:export':
      void exportConnections()
      break
    case 'tab:close':
      if (tabs.activeId) tabs.close(tabs.activeId)
      break
    case 'tab:next':
      tabs.cycle(1)
      break
    case 'tab:previous':
      tabs.cycle(-1)
      break
    case 'query:run':
      focusedView.value?.run()
      break
    case 'query:run-selection':
      focusedView.value?.runSelection()
      break
    case 'query:run-current':
      focusedView.value?.runCurrent()
      break
    case 'query:cancel':
      focusedView.value?.cancel()
      break
    case 'query:format':
      focusedView.value?.format()
      break
    case 'query:save':
      focusedView.value?.save()
      break
    case 'query:save-as':
      focusedView.value?.saveAs()
      break
    case 'query:open-file':
      focusedView.value?.openFile()
      break
    case 'results:export':
      focusedView.value?.exportRows()
      break
    case 'view:split-tab':
      if (tabs.activeId) void tabs.splitTab(tabs.activeId)
      break
    case 'view:close-split':
      void tabs.closeSplit()
      break
    case 'tab:detach':
      if (tabs.activeId) {
        void detachTab(tabs.activeId, { x: window.screenX + 80, y: window.screenY + 80 })
      }
      break
    case 'view:toggle-sidebar':
      sidebarCollapsed.value = !sidebarCollapsed.value
      break
    case 'view:toggle-row-panel':
      // The tab owns its row panel, so this is the focused pane's tab alone.
      focusedView.value?.toggleRowPanel()
      break
    case 'view:toggle-theme':
      settings.toggleTheme()
      break
    case 'view:focus-filter':
      if (tabs.active?.kind === 'table') focusedView.value?.focusFilter()
      else sidebar.value?.focusFilter()
      break
    case 'schema:refresh':
      if (tabs.active?.kind === 'table' || tabs.active?.kind === 'activity') {
        focusedView.value?.refresh()
      } else void sidebar.value?.refresh()
      break
    case 'connection:disconnect':
      void disconnect()
      break
    case 'connection:toggle-read-only':
      // The status bar's padlock, from the menu: on at once, off once asked.
      if (connections.active) {
        void readOnly.setReadOnly(connections.active, !connections.readOnly)
      }
      break
    case 'connection:toggle-confirm-writes':
      // The status bar's other switch: on at once, off once asked if it must.
      if (connections.active) {
        void readOnly.setConfirmWrites(connections.active, !connections.confirmWrites)
      }
      break
    case 'help:shortcuts':
      showShortcuts.value = true
      break
    case 'view:quick-open':
      showQuickOpen.value = true
      break
    case 'view:activity':
      if (connectionId.value) void tabs.openActivity(connectionId.value)
      break
  }
}

/**
 * The application menu already binds most accelerators; these cover the ones
 * Electron cannot express (Ctrl+Tab) and keep shortcuts working when the menu
 * is hidden.
 */
function onKeydown(event: KeyboardEvent): void {
  const mod = event.ctrlKey || event.metaKey
  if (!mod) return

  if (event.key === 'Tab') {
    event.preventDefault()
    tabs.cycle(event.shiftKey ? -1 : 1)
    return
  }
  if (event.key.toLowerCase() === 'b') {
    event.preventDefault()
    sidebarCollapsed.value = !sidebarCollapsed.value
    return
  }
  if (event.key === '/') {
    event.preventDefault()
    showShortcuts.value = true
    return
  }
  if (event.key.toLowerCase() === 'p' && !event.shiftKey && !event.altKey) {
    event.preventDefault()
    showQuickOpen.value = true
  }
}

/**
 * A status the main process pushed, rather than one this window asked for.
 *
 * The interesting ones are the connection dropping and coming back on its own:
 * the workspace stays where it is either way, so without a word about it the
 * only sign would be queries quietly failing for a few seconds.
 */
function onStatusChanged(status: ConnectionStatus): void {
  const before = connections.statusFor(status.connectionId).state
  connections.setStatus(status)
  if (status.connectionId !== connections.activeId || status.state === before) return

  if (status.state === 'connecting' && before === 'connected') {
    toasts.info('The connection dropped — reopening it', status.error?.message)
  } else if (status.state === 'connected' && before !== 'connected') {
    toasts.success('Connection restored')
  } else if (status.state === 'disconnected' || status.state === 'error') {
    toasts.error('The connection closed', status.error?.message)
  }
}

let unsubscribeMenu: (() => void) | null = null
let unsubscribeStatus: (() => void) | null = null

/**
 * Reads the connection's schema, and reads it again for the next connection.
 *
 * The workspace owns this rather than the tree that draws it: the editor's
 * autocomplete reads the same store, and a window opened for one dragged-out
 * tab has no tree on screen — its query tabs should still complete table and
 * column names.
 */
watch(
  connectionId,
  (id, previous) => {
    if (previous) schema.reset()
    if (previous) recent.value = []
    if (id) void schema.loadAll(id)
  },
  { immediate: true }
)

// --- open tabs, across restarts --------------------------------------------

/**
 * Whether this window's tabs are the ones to bring back next time.
 *
 * A one-tab window is not: it holds what was dragged out of another, whose
 * own tabs are the session. Off while the window opens, so the restore is not
 * written back over itself half-done, and while disconnecting.
 */
let keepingTabs = false

const openTabs = computed(() =>
  connectionId.value ? JSON.stringify(tabs.snapshot(connectionId.value)) : null
)
watch(openTabs, (saved) => {
  if (!keepingTabs || props.detached || saved === null || !connectionId.value) return
  if (!settings.settings.restoreTabs) return
  uiState.rememberTabs(connectionId.value, JSON.parse(saved))
})

/** Opens the tabs this connection had last time, or a blank query. */
async function openStartingTabs(): Promise<void> {
  const id = connectionId.value
  if (tabs.tabs.length > 0 || !id) return
  if (!props.detached && settings.settings.restoreTabs) {
    const saved = await uiState.savedTabsFor(id)
    if (saved && tabs.tabs.length === 0 && tabs.restore(id, saved)) return
  }
  if (tabs.tabs.length === 0) newQueryTab()
}

onMounted(async () => {
  document.addEventListener('keydown', onKeydown)
  unsubscribeMenu = onMenuAction(handleAction)
  unsubscribeStatus = api.onStatusChanged(onStatusChanged)
  try {
    await openStartingTabs()
  } finally {
    keepingTabs = true
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  unsubscribeMenu?.()
  unsubscribeStatus?.()
})
</script>

<template>
  <div class="workspace">
    <SplitPane
      v-model="sidebarWidth"
      direction="horizontal"
      :min="180"
      :max="520"
      :collapsed="sidebarCollapsed"
    >
      <template #first>
        <AppSidebar
          v-if="sidebarMounted"
          ref="sidebar"
          @open-table="(s, t, type) => openTable(s, t, type, 'data')"
          @open-structure="(s, t, type) => openTable(s, t, type, 'structure')"
          @open-sql="openSql"
          @open-routine="openRoutine"
          @generate="generate"
        />
      </template>

      <template #second>
        <div ref="mainArea" class="workspace__main">
          <!--
            One pane, or two side by side once a tab has been split off. The
            split pane is always the one rendering the first pane, collapsed
            rather than replaced when there is no second — swapping between two
            layouts would remount the first pane's view and take its staged
            edits with it.
          -->
          <SplitPane
            v-model="splitWidth"
            direction="horizontal"
            pane="second"
            :min="320"
            :max="1600"
            :collapsed="!tabs.isSplit"
          >
            <template #first>
              <TabPaneView
                ref="primaryPane"
                :pane="tabs.panes[0]"
                :has-sidebar="sidebarMounted && !sidebarCollapsed"
                @new-query="newQueryTab"
                @export="(columns, rows, name) => (exportPayload = { columns, rows, name })"
                @open-sql="openSql"
                @open-related="openRelated"
                @detach="detachTab"
                @drop-out="dropTab"
              />
            </template>
            <template #second>
              <TabPaneView
                v-if="tabs.panes[1]"
                ref="secondaryPane"
                :pane="tabs.panes[1]"
                :has-sidebar="sidebarMounted && !sidebarCollapsed"
                @new-query="newQueryTab"
                @export="(columns, rows, name) => (exportPayload = { columns, rows, name })"
                @open-sql="openSql"
                @open-related="openRelated"
                @detach="detachTab"
                @drop-out="dropTab"
              />
            </template>
          </SplitPane>
        </div>
      </template>
    </SplitPane>

    <StatusBar
      @disconnect="disconnect"
      @reconnect="connections.reconnect()"
      @settings="showSettings = true"
      @shortcuts="showShortcuts = true"
    />

    <ExportDialog
      v-if="exportPayload"
      :columns="exportPayload.columns"
      :rows="exportPayload.rows"
      :table-name="exportPayload.name"
      @close="exportPayload = null"
    />
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
    <ShortcutsDialog v-if="showShortcuts" @close="showShortcuts = false" />
    <QuickOpen
      v-if="showQuickOpen"
      :recent="recent"
      @open="openPicked"
      @close="showQuickOpen = false"
    />
    <!-- Raised by the tab store from wherever a routine's tab is closed. -->
    <UnsavedRoutineDialog v-if="tabs.closePrompt" />
    <!-- …and from wherever a query tab's session would end with a transaction open. -->
    <OpenTransactionDialog v-if="tabs.transactionPrompt" />
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-app);
}
.workspace > :first-child {
  flex: 1;
  min-height: 0;
}
.workspace__main {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.workspace__main > * {
  flex: 1;
  min-height: 0;
}
</style>
