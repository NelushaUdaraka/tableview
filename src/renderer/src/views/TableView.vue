<script setup lang="ts">
import { ref } from 'vue'
import type { CellValue, ColumnMeta } from '@shared/types'
import TableDataView from './TableDataView.vue'
import TableStructureView from './TableStructureView.vue'
import { useTabStore } from '../stores/tabs'
import type { TableTab } from '../stores/tabs'

const props = defineProps<{ tab: TableTab }>()
const emit = defineEmits<{
  (event: 'export', columns: ColumnMeta[], rows: CellValue[][], name: string): void
  (event: 'open-sql', sql: string, title: string): void
}>()

const tabs = useTabStore()
const dataView = ref<InstanceType<typeof TableDataView> | null>(null)

function setView(view: 'data' | 'structure'): void {
  tabs.update<TableTab>(props.tab.id, { view })
}

defineExpose({
  refresh: () => dataView.value?.refresh(),
  focusFilter: () => dataView.value?.focusFilter(),
  exportRows: () => dataView.value?.exportRows()
})
</script>

<template>
  <div class="table-view">
    <nav class="table-view__tabs">
      <button
        class="table-view__tab"
        :class="{ 'table-view__tab--active': tab.view === 'data' }"
        @click="setView('data')"
      >
        Data
        <span v-if="tab.pendingEdits > 0" class="table-view__badge">{{ tab.pendingEdits }}</span>
      </button>
      <button
        class="table-view__tab"
        :class="{ 'table-view__tab--active': tab.view === 'structure' }"
        @click="setView('structure')"
      >
        Structure
      </button>
      <div class="table-view__name mono truncate">{{ tab.schema }}.{{ tab.table }}</div>
    </nav>

    <div class="table-view__body">
      <!-- Keyed so switching tables remounts and reloads. -->
      <TableDataView
        v-if="tab.view === 'data'"
        ref="dataView"
        :key="`${tab.id}-data`"
        :tab="tab"
        @export="(columns, rows, name) => emit('export', columns, rows, name)"
      />
      <TableStructureView
        v-else
        :key="`${tab.id}-structure`"
        :tab="tab"
        @open-sql="(sql, title) => emit('open-sql', sql, title)"
      />
    </div>
  </div>
</template>

<style scoped>
.table-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.table-view__tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  flex: 0 0 auto;
}
.table-view__tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.table-view__tab--active {
  color: var(--text-primary);
  border-bottom-color: var(--accent);
}
.table-view__badge {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 10px;
}
.table-view__name {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
}
.table-view__body {
  flex: 1;
  min-height: 0;
}
</style>
