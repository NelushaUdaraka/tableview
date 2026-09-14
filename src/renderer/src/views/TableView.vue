<script setup lang="ts">
import { ref } from 'vue'
import type { CellValue, ColumnMeta, TableFilter } from '@shared/types'
import TableDataView from './TableDataView.vue'
import TableStructureView from './TableStructureView.vue'
import type { TableTab } from '../stores/tabs'

defineProps<{ tab: TableTab }>()
const emit = defineEmits<{
  (event: 'export', columns: ColumnMeta[], rows: CellValue[][], name: string): void
  (event: 'open-sql', sql: string, title: string): void
  (event: 'open-related', schema: string, table: string, filters: TableFilter[]): void
}>()

const dataView = ref<InstanceType<typeof TableDataView> | null>(null)

defineExpose({
  refresh: () => dataView.value?.refresh(),
  focusFilter: () => dataView.value?.focusFilter(),
  exportRows: () => dataView.value?.exportRows(),
  // Nothing to toggle on the structure view, which has no rows to detail.
  toggleRowPanel: () => dataView.value?.toggleRowPanel()
})
</script>

<template>
  <div class="table-view">
    <div class="table-view__body">
      <!-- Keyed so switching tables remounts and reloads. -->
      <TableDataView
        v-if="tab.view === 'data'"
        ref="dataView"
        :key="`${tab.id}-data`"
        :tab="tab"
        @export="(columns, rows, name) => emit('export', columns, rows, name)"
        @open-related="(schema, table, filters) => emit('open-related', schema, table, filters)"
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
.table-view__body {
  flex: 1;
  min-height: 0;
}
</style>
