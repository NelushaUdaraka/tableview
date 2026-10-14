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
import AppSidebar from '../components/AppSidebar.vue'
import SplitPane from '../components/SplitPane.vue'
import StatusBar from '../components/StatusBar.vue'
import ExportDialog from '../components/ExportDialog.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import ShortcutsDialog from '../components/ShortcutsDialog.vue'
import TabPaneView from './TabPaneView.vue'
import { useConnectionStore } from '../stores/connections'
import { useSchemaStore } from '../stores/schema'
import { useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'
import { useToastStore } from '../stores/toasts'
import { onMenuAction } from '../lib/menuBus'
import { exportConnections, importConnections } from '../lib/connectionTransfer'
import { detachedTabFrom } from '../lib/detach'
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
const schema = useSchemaStore()
const settings = useSettingsStore()
const tabs = useTabStore()
const toasts = useToastStore()

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
const sidebarWidth = ref(280)
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
 */
const sidebarCollapsed = ref(props.detached)
const sidebarMounted = ref(!props.detached)
watch(sidebarCollapsed, (collapsed) => {
  if (!collapsed) sidebarMounted.value = true
})

const showSettings = ref(false)
const showShortcuts = ref(false)
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

  if (!(await tabs.close(tabId))) return

  try {
    await hand(payload)
    closeIfEmptied()
  } catch (error) {
    toasts.fromError(failure, error)
    // Put it back rather than losing it to a window that never took it.
    if (payload.kind === 'table' && payload.schema && payload.table) {
      void tabs.openTable(payload.connectionId, payload.schema, payload.table, payload.objectType)
    } else {
      void tabs.openQuery(payload.connectionId, payload.sql ?? '', payload.title)
    }
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

async function disconnect(): Promise<void> {
  const id = connections.activeId
  if (!id) return
  tabs.closeForConnection(id)
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
      if (tabs.active?.kind === 'table') focusedView.value?.refresh()
      else void sidebar.value?.refresh()
      break
    case 'connection:disconnect':
      void disconnect()
      break
    case 'help:shortcuts':
      showShortcuts.value = true
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
    if (id) void schema.loadAll(id)
  },
  { immediate: true }
)

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  unsubscribeMenu = onMenuAction(handleAction)
  unsubscribeStatus = api.onStatusChanged(onStatusChanged)
  if (tabs.tabs.length === 0) newQueryTab()
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
