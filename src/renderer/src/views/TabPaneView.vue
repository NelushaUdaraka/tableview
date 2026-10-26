<script setup lang="ts">
/**
 * One pane of the workspace: a strip of tabs and whichever one is showing.
 *
 * The workspace holds one of these, or two side by side once a tab has been
 * split off. Everything a menu action needs to reach — running a query,
 * refreshing a table — is exposed here, and the workspace routes to whichever
 * pane has the focus.
 */
import { computed, ref } from 'vue'
import type { CellValue, ColumnMeta, TableFilter } from '@shared/types'
import AppIcon from '../components/AppIcon.vue'
import TabBar from '../components/TabBar.vue'
import QueryView from './QueryView.vue'
import TableView from './TableView.vue'
import ActivityView from './ActivityView.vue'
import { useTabStore } from '../stores/tabs'
import type { ActivityTab, QueryTab, TableTab, TabPane } from '../stores/tabs'

const props = withDefaults(
  defineProps<{
    pane: TabPane
    /** False in a window opened for one dragged-out tab, where there is none. */
    hasSidebar?: boolean
  }>(),
  { hasSidebar: true }
)
const emit = defineEmits<{
  (event: 'export', columns: ColumnMeta[], rows: CellValue[][], name?: string): void
  (event: 'open-sql', sql: string, title: string): void
  (event: 'open-related', schema: string, table: string, filters: TableFilter[]): void
  (event: 'new-query'): void
  (event: 'detach', tabId: string, position: { x: number; y: number }): void
  (event: 'drop-out', tabId: string, point: { x: number; y: number }): void
}>()

const tabs = useTabStore()
const queryView = ref<InstanceType<typeof QueryView> | null>(null)
const tableView = ref<InstanceType<typeof TableView> | null>(null)
const activityView = ref<InstanceType<typeof ActivityView> | null>(null)

const tab = computed(
  () => tabs.tabs.find((entry) => entry.id === props.pane.activeTabId) ?? null
)
const focused = computed(() => tabs.focusedPaneId === props.pane.id)

defineExpose({
  run: () => queryView.value?.run(),
  runSelection: () => queryView.value?.runSelection(),
  runCurrent: () => queryView.value?.runCurrent(),
  cancel: () => void queryView.value?.cancel(),
  format: () => queryView.value?.format(),
  save: () => void queryView.value?.save(),
  saveAs: () => void queryView.value?.saveAs(),
  openFile: () => void queryView.value?.openFile(),
  refresh: () => {
    tableView.value?.refresh()
    activityView.value?.refresh()
  },
  focusFilter: () => tableView.value?.focusFilter(),
  exportRows: () => tableView.value?.exportRows(),
  importFile: () => tableView.value?.importFile(),
  // Both kinds of tab have one, so whichever is mounted takes it.
  toggleRowPanel: () => {
    queryView.value?.toggleRowPanel()
    tableView.value?.toggleRowPanel()
  }
})
</script>

<template>
  <!-- Clicking anywhere in a pane makes it the one menu actions act on. -->
  <div class="pane" :class="{ 'pane--focused': focused && tabs.isSplit }" @mousedown="tabs.focusPane(pane.id)">
    <TabBar
      :pane="pane"
      @new-query="emit('new-query')"
      @detach="(tabId, position) => emit('detach', tabId, position)"
      @drop-out="(tabId, point) => emit('drop-out', tabId, point)"
    />

    <div class="pane__content">
      <QueryView
        v-if="tab?.kind === 'query'"
        ref="queryView"
        :key="tab.id"
        :tab="tab as QueryTab"
        @export="(columns, rows) => emit('export', columns, rows)"
      />
      <TableView
        v-else-if="tab?.kind === 'table'"
        ref="tableView"
        :key="tab.id"
        :tab="tab as TableTab"
        @export="(columns, rows, name) => emit('export', columns, rows, name)"
        @open-sql="(sql, title) => emit('open-sql', sql, title)"
        @open-related="(schema, table, filters) => emit('open-related', schema, table, filters)"
      />
      <ActivityView
        v-else-if="tab?.kind === 'activity'"
        ref="activityView"
        :key="tab.id"
        :tab="tab as ActivityTab"
        @open-sql="(sql, title) => emit('open-sql', sql, title)"
      />
      <div v-else class="empty-state">
        <div class="empty-state__icon"><AppIcon name="terminal" :size="20" /></div>
        <div class="empty-state__title">No open tabs</div>
        <p v-if="hasSidebar">Pick a table on the left, or open a query tab.</p>
        <!-- No tree to pick from in a detached window, so say where it is. -->
        <p v-else>Open a query tab, or bring the schema tree in with Ctrl+B.</p>
        <button class="btn btn--primary" @click="emit('new-query')">
          <AppIcon name="plus" :size="14" />
          New query tab
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
}
/* Only worth marking when there are two: the focused pane is the one that
   answers Ctrl+Enter, and with one pane that is never in doubt. */
.pane--focused .pane__content {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
}
.pane__content {
  flex: 1;
  min-height: 0;
  background: var(--bg-surface);
}
</style>
