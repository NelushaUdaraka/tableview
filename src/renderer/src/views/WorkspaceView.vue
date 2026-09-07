<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CellValue, ColumnMeta, SchemaObjectType, TableFilter } from '@shared/types'
import {
  buildCreateTableDdl,
  buildDeleteTemplate,
  buildInsertTemplate,
  buildSelectTemplate,
  buildUpdateTemplate
} from '@shared/sql/builder'
import AppSidebar from '../components/AppSidebar.vue'
import TabBar from '../components/TabBar.vue'
import SplitPane from '../components/SplitPane.vue'
import StatusBar from '../components/StatusBar.vue'
import ExportDialog from '../components/ExportDialog.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import ShortcutsDialog from '../components/ShortcutsDialog.vue'
import QueryView from './QueryView.vue'
import TableView from './TableView.vue'
import { useConnectionStore } from '../stores/connections'
import { useSchemaStore } from '../stores/schema'
import { useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'
import { useToastStore } from '../stores/toasts'
import type { QueryTab, TableTab } from '../stores/tabs'
import { onMenuAction } from '../lib/menuBus'
import { api } from '../lib/api'

const connections = useConnectionStore()
const schema = useSchemaStore()
const settings = useSettingsStore()
const tabs = useTabStore()
const toasts = useToastStore()

const sidebar = ref<InstanceType<typeof AppSidebar> | null>(null)
const queryView = ref<InstanceType<typeof QueryView> | null>(null)
const tableView = ref<InstanceType<typeof TableView> | null>(null)

const sidebarWidth = ref(260)
const sidebarCollapsed = ref(false)
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
      queryView.value?.run()
      break
    case 'query:run-selection':
      queryView.value?.runSelection()
      break
    case 'query:run-current':
      queryView.value?.runCurrent()
      break
    case 'query:cancel':
      void queryView.value?.cancel()
      break
    case 'query:format':
      queryView.value?.format()
      break
    case 'query:save':
      void queryView.value?.save()
      break
    case 'query:save-as':
      void queryView.value?.saveAs()
      break
    case 'query:open-file':
      void queryView.value?.openFile()
      break
    case 'results:export':
      tableView.value?.exportRows()
      break
    case 'view:toggle-sidebar':
      sidebarCollapsed.value = !sidebarCollapsed.value
      break
    case 'view:toggle-row-panel':
      void settings.update({ showRowPanel: !settings.settings.showRowPanel })
      break
    case 'view:toggle-theme':
      settings.toggleTheme()
      break
    case 'view:focus-filter':
      if (tabs.active?.kind === 'table') tableView.value?.focusFilter()
      else sidebar.value?.focusFilter()
      break
    case 'schema:refresh':
      if (tabs.active?.kind === 'table') tableView.value?.refresh()
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

let unsubscribeMenu: (() => void) | null = null
let unsubscribeStatus: (() => void) | null = null

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  unsubscribeMenu = onMenuAction(handleAction)
  unsubscribeStatus = api.onStatusChanged((status) => connections.setStatus(status))
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
          ref="sidebar"
          @open-table="(s, t, type) => openTable(s, t, type, 'data')"
          @open-structure="(s, t, type) => openTable(s, t, type, 'structure')"
          @open-sql="openSql"
          @generate="generate"
        />
      </template>

      <template #second>
        <div class="workspace__main">
          <TabBar @new-query="newQueryTab" />

          <div class="workspace__content">
            <QueryView
              v-if="tabs.active?.kind === 'query'"
              ref="queryView"
              :key="tabs.active.id"
              :tab="tabs.active as QueryTab"
              @export="(columns, rows) => (exportPayload = { columns, rows })"
            />
            <TableView
              v-else-if="tabs.active?.kind === 'table'"
              ref="tableView"
              :key="tabs.active.id"
              :tab="tabs.active as TableTab"
              @export="(columns, rows, name) => (exportPayload = { columns, rows, name })"
              @open-sql="openSql"
              @open-related="openRelated"
            />
            <div v-else class="empty-state">
              <div class="empty-state__title">No open tabs</div>
              <p>Pick a table on the left, or open a query tab.</p>
              <button class="btn btn--primary" @click="newQueryTab">New query tab</button>
            </div>
          </div>
        </div>
      </template>
    </SplitPane>

    <StatusBar
      @disconnect="disconnect"
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
.workspace__content {
  flex: 1;
  min-height: 0;
  background: var(--bg-surface);
}
</style>
