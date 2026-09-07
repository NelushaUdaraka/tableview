<script setup lang="ts">
/**
 * Table browser with staged editing.
 *
 * Edits are held locally until "Apply", then sent as one change set that the
 * main process runs inside a transaction. Rows are addressed by their primary
 * key; a table without one falls back to matching on every column, which the
 * banner warns about because it can match more rows than intended.
 */
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import type {
  CellValue,
  ColumnMeta,
  TableChangeSet,
  TableColumn,
  TableFilter,
  TableSort,
  TableStructure
} from '@shared/types'
import DataGrid, { type RowState } from '../components/DataGrid.vue'
import FilterBuilder from '../components/FilterBuilder.vue'
import ContextMenu, { type MenuEntry } from '../components/ContextMenu.vue'
import { exportRows } from '@shared/export'
import { useSettingsStore } from '../stores/settings'
import { useSchemaStore } from '../stores/schema'
import { useTabStore } from '../stores/tabs'
import { useToastStore } from '../stores/toasts'
import type { TableTab } from '../stores/tabs'
import { api } from '../lib/api'

const props = defineProps<{ tab: TableTab }>()
const emit = defineEmits<{
  (event: 'export', columns: ColumnMeta[], rows: CellValue[][], name: string): void
}>()

const settings = useSettingsStore()
const schemaStore = useSchemaStore()
const tabs = useTabStore()
const toasts = useToastStore()

const structure = ref<TableStructure | null>(null)
const columns = shallowRef<ColumnMeta[]>([])
// shallowRef: the rows array is replaced wholesale, and its contents must not
// be wrapped in reactive proxies (both for speed and because a proxy cannot
// cross the IPC boundary).
const loadedRows = shallowRef<CellValue[][]>([])
const totalRows = ref<number | null>(null)
const loading = ref(false)
const durationMs = ref(0)
const lastSql = ref('')
const grid = ref<InstanceType<typeof DataGrid> | null>(null)
const menu = ref<{ x: number; y: number; row: number; col: number } | null>(null)

const offset = ref(0)
const pageSize = ref(settings.settings.pageSize)
const sorts = ref<TableSort[]>([])
const filters = ref<TableFilter[]>([])
const filterMode = ref<'builder' | 'raw'>('builder')
const rawWhere = ref('')
const showFilters = ref(false)

/** Staged changes. */
const edits = reactive<Record<string, CellValue>>({})
const deletedRows = ref<Set<number>>(new Set())
const newRows = shallowRef<CellValue[][]>([])
const applying = ref(false)

const isView = computed(() => props.tab.objectType === 'view')
const primaryKey = computed(() => structure.value?.primaryKey ?? [])
const hasPrimaryKey = computed(() => primaryKey.value.length > 0)
const editable = computed(() => !isView.value)

const allRows = computed(() => [...loadedRows.value, ...newRows.value])

const rowStates = computed<RowState[]>(() => {
  const states: RowState[] = loadedRows.value.map((_, index) =>
    deletedRows.value.has(index) ? 'deleted' : 'normal'
  )
  return [...states, ...newRows.value.map(() => 'inserted' as RowState)]
})

const pendingCount = computed(() => {
  const updated = new Set(
    Object.keys(edits)
      .map((key) => Number(key.split(':')[0]))
      .filter((index) => index < loadedRows.value.length && !deletedRows.value.has(index))
  )
  return updated.size + deletedRows.value.size + newRows.value.length
})

watch(pendingCount, (count) => {
  tabs.update<TableTab>(props.tab.id, { pendingEdits: count })
})

const pageInfo = computed(() => {
  const from = allRows.value.length === 0 ? 0 : offset.value + 1
  const to = offset.value + loadedRows.value.length
  const total = totalRows.value === null ? '?' : totalRows.value.toLocaleString()
  return `${from.toLocaleString()}–${to.toLocaleString()} of ${total}`
})

const canPrevious = computed(() => offset.value > 0)
const canNext = computed(() =>
  totalRows.value === null
    ? loadedRows.value.length === pageSize.value
    : offset.value + pageSize.value < totalRows.value
)

function discard(): void {
  for (const key of Object.keys(edits)) delete edits[key]
  deletedRows.value = new Set()
  newRows.value = []
}

async function loadStructure(): Promise<void> {
  try {
    structure.value = await schemaStore.getStructure(
      props.tab.connectionId,
      props.tab.schema,
      props.tab.table
    )
  } catch (error) {
    toasts.fromError('Could not read the table structure', error)
  }
}

async function load(resetOffset = false): Promise<void> {
  if (resetOffset) offset.value = 0
  loading.value = true
  try {
    const response = await api.fetchTableData({
      connectionId: props.tab.connectionId,
      schema: props.tab.schema,
      table: props.tab.table,
      offset: offset.value,
      limit: pageSize.value,
      sorts: sorts.value,
      filters: filters.value,
      filterMode: filterMode.value,
      rawWhere: rawWhere.value
    })
    columns.value = response.columns
    loadedRows.value = response.rows
    totalRows.value = response.totalRows
    durationMs.value = response.durationMs
    lastSql.value = response.sql
    discard()
  } catch (error) {
    toasts.fromError('Could not load the table', error)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadStructure()
  // A primary key gives a stable default order.
  const key = structure.value?.primaryKey ?? []
  sorts.value = key.length ? key.map((column) => ({ column, direction: 'asc' as const })) : []
  await load()
})

function onSort(column: string, additive: boolean): void {
  const existing = sorts.value.find((sort) => sort.column === column)
  if (additive) {
    sorts.value = existing
      ? sorts.value.map((sort) =>
          sort.column === column
            ? { ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
            : sort
        )
      : [...sorts.value, { column, direction: 'asc' }]
  } else {
    sorts.value =
      existing && existing.direction === 'asc'
        ? [{ column, direction: 'desc' }]
        : existing
          ? []
          : [{ column, direction: 'asc' }]
  }
  void load(true)
}

function onEdit(rowIndex: number, columnIndex: number, value: CellValue): void {
  if (!editable.value) {
    toasts.info('Views cannot be edited')
    return
  }
  edits[`${rowIndex}:${columnIndex}`] = value
}

function addRow(): void {
  if (!editable.value) return
  newRows.value = [...newRows.value, columns.value.map(() => null)]
}

function deleteSelected(rowIndex: number): void {
  if (!editable.value) return
  if (rowIndex >= loadedRows.value.length) {
    // Dropping a staged insert just removes it.
    const newIndex = rowIndex - loadedRows.value.length
    newRows.value = newRows.value.filter((_, index) => index !== newIndex)
    for (const key of Object.keys(edits)) {
      if (Number(key.split(':')[0]) === rowIndex) delete edits[key]
    }
    return
  }
  const next = new Set(deletedRows.value)
  if (next.has(rowIndex)) next.delete(rowIndex)
  else next.add(rowIndex)
  deletedRows.value = next
}

/** The values that identify a stored row, taken from its unedited state. */
function keyFor(rowIndex: number): Record<string, CellValue> {
  const row = loadedRows.value[rowIndex]
  const keyColumns = hasPrimaryKey.value
    ? primaryKey.value
    : columns.value.map((column) => column.name)

  const key: Record<string, CellValue> = {}
  for (const name of keyColumns) {
    const index = columns.value.findIndex((column) => column.name === name)
    if (index >= 0) key[name] = row[index] ?? null
  }
  return key
}

function buildChangeSet(): TableChangeSet {
  const updates: TableChangeSet['updates'] = []
  const inserts: TableChangeSet['inserts'] = []

  const byRow = new Map<number, Record<string, CellValue>>()
  for (const [key, value] of Object.entries(edits)) {
    const [rowText, colText] = key.split(':')
    const rowIndex = Number(rowText)
    const column = columns.value[Number(colText)]
    if (!column) continue
    if (!byRow.has(rowIndex)) byRow.set(rowIndex, {})
    byRow.get(rowIndex)![column.name] = value
  }

  for (const [rowIndex, changes] of byRow) {
    if (rowIndex < loadedRows.value.length) {
      if (deletedRows.value.has(rowIndex)) continue
      updates.push({ key: keyFor(rowIndex), changes })
    }
  }

  newRows.value.forEach((_, newIndex) => {
    const rowIndex = loadedRows.value.length + newIndex
    const values = byRow.get(rowIndex) ?? {}
    // Identity and computed columns are server-generated.
    const writable: Record<string, CellValue> = {}
    for (const [name, value] of Object.entries(values)) {
      const column = structure.value?.columns.find((entry) => entry.name === name)
      if (column?.isIdentity || column?.isComputed) continue
      writable[name] = value
    }
    inserts.push({ tempId: `new-${newIndex}`, values: writable })
  })

  return {
    connectionId: props.tab.connectionId,
    schema: props.tab.schema,
    table: props.tab.table,
    inserts,
    updates,
    deletes: [...deletedRows.value].map((rowIndex) => ({ key: keyFor(rowIndex) }))
  }
}

async function apply(): Promise<void> {
  if (pendingCount.value === 0) return
  const changeSet = buildChangeSet()

  if (settings.settings.confirmBeforeApply) {
    const summary = [
      changeSet.inserts.length ? `${changeSet.inserts.length} insert` : '',
      changeSet.updates.length ? `${changeSet.updates.length} update` : '',
      changeSet.deletes.length ? `${changeSet.deletes.length} delete` : ''
    ]
      .filter(Boolean)
      .join(', ')
    const warning = hasPrimaryKey.value
      ? ''
      : '\n\nThis table has no primary key, so rows are matched on every column. More than one row may be affected.'
    if (!confirm(`Apply ${summary} to ${props.tab.schema}.${props.tab.table}?${warning}`)) return
  }

  applying.value = true
  try {
    const applied = await api.applyChanges(changeSet)
    toasts.success(
      'Changes applied',
      `${applied.inserted} inserted, ${applied.updated} updated, ${applied.deleted} deleted`
    )
    await load()
  } catch (error) {
    toasts.fromError('Could not apply the changes — nothing was committed', error)
  } finally {
    applying.value = false
  }
}

function goToPage(delta: number): void {
  const next = offset.value + delta * pageSize.value
  offset.value = Math.max(0, next)
  void load()
}

const menuItems = computed<MenuEntry[]>(() => [
  { label: 'Copy cell', action: 'copy-cell' },
  { label: 'Copy row', action: 'copy-row' },
  { separator: true, label: '' },
  { label: 'Set NULL', action: 'null', disabled: !editable.value },
  { label: 'Add row', action: 'add', disabled: !editable.value },
  {
    label:
      menu.value && deletedRows.value.has(menu.value.row) ? 'Undo delete row' : 'Delete row',
    action: 'delete',
    danger: true,
    disabled: !editable.value
  },
  { separator: true, label: '' },
  { label: 'Copy as CSV', action: 'copy-csv' },
  { label: 'Export…', action: 'export' }
])

async function onMenuSelect(action: string): Promise<void> {
  const target = menu.value
  if (!target) return

  switch (action) {
    case 'copy-cell':
      await grid.value?.copySelection(false)
      break
    case 'copy-row':
      await grid.value?.copySelection(true)
      break
    case 'null':
      onEdit(target.row, target.col, null)
      break
    case 'add':
      addRow()
      break
    case 'delete':
      deleteSelected(target.row)
      break
    case 'copy-csv': {
      const text = exportRows(columns.value, allRows.value, { format: 'csv', includeHeader: true })
      await api.copyToClipboard(text)
      toasts.info(`Copied ${allRows.value.length} rows`)
      break
    }
    case 'export':
      emit('export', columns.value, allRows.value, `${props.tab.schema}.${props.tab.table}`)
      break
  }
}

defineExpose({
  refresh: () => load(),
  focusFilter: () => {
    showFilters.value = true
  },
  exportRows: () =>
    emit('export', columns.value, allRows.value, `${props.tab.schema}.${props.tab.table}`)
})

const structureColumns = computed<TableColumn[]>(() => structure.value?.columns ?? [])
</script>

<template>
  <div class="data">
    <div class="data__toolbar">
      <button class="btn btn--sm btn--ghost" :disabled="loading" @click="load()">⟳ Refresh</button>
      <button
        class="btn btn--sm btn--ghost"
        :class="{ 'btn--active': showFilters }"
        @click="showFilters = !showFilters"
      >
        Filter
        <span v-if="filters.length || rawWhere" class="data__dot"></span>
      </button>

      <div class="data__spacer"></div>

      <template v-if="editable">
        <button class="btn btn--sm btn--ghost" @click="addRow">+ Row</button>
        <button
          v-if="pendingCount > 0"
          class="btn btn--sm"
          :disabled="applying"
          @click="discard"
        >
          Discard
        </button>
        <button
          v-if="pendingCount > 0"
          class="btn btn--sm btn--primary"
          :disabled="applying"
          @click="apply"
        >
          <span v-if="applying" class="spinner"></span>
          Apply {{ pendingCount }}
        </button>
      </template>
      <span v-else class="badge">read only</span>
    </div>

    <FilterBuilder
      v-if="showFilters"
      :columns="structureColumns"
      :filters="filters"
      :mode="filterMode"
      :raw-where="rawWhere"
      @update:filters="filters = $event"
      @update:mode="filterMode = $event"
      @update:raw-where="rawWhere = $event"
      @apply="load(true)"
    />

    <div v-if="editable && !hasPrimaryKey" class="data__warning">
      This table has no primary key. Edits match rows on every column, so a duplicate row would be
      changed more than once.
    </div>

    <div class="data__grid">
      <DataGrid
        ref="grid"
        :columns="columns"
        :rows="allRows"
        :row-states="rowStates"
        :edited-cells="edits"
        :editable="editable"
        :loading="loading"
        :sorts="sorts"
        :row-offset="offset"
        :primary-key="primaryKey"
        empty-message="No rows match"
        @edit="onEdit"
        @sort="onSort"
        @row-context="menu = { x: $event.x, y: $event.y, row: $event.rowIndex, col: $event.columnIndex }"
      />
    </div>

    <div class="data__foot">
      <button class="btn btn--sm btn--ghost" :disabled="!canPrevious || loading" @click="goToPage(-1)">
        ‹ Prev
      </button>
      <span class="data__page">{{ pageInfo }}</span>
      <button class="btn btn--sm btn--ghost" :disabled="!canNext || loading" @click="goToPage(1)">
        Next ›
      </button>

      <select
        v-model.number="pageSize"
        class="select data__pagesize"
        @change="load(true)"
      >
        <option :value="50">50</option>
        <option :value="100">100</option>
        <option :value="200">200</option>
        <option :value="500">500</option>
        <option :value="1000">1000</option>
      </select>

      <div class="data__spacer"></div>
      <span class="muted">{{ durationMs }} ms</span>
      <span class="muted mono truncate data__sql" :title="lastSql">
        {{ lastSql.replace(/\s+/g, ' ') }}
      </span>
    </div>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @select="onMenuSelect"
      @close="menu = null"
    />
  </div>
</template>

<style scoped>
.data {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.data__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
  flex: 0 0 auto;
}
.data__spacer {
  flex: 1;
}
.data__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 5px;
  border-radius: 50%;
  background: var(--accent);
}
.btn--active {
  background: var(--bg-active);
}
.data__warning {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--text-primary);
  font-size: 11px;
}
.data__grid {
  flex: 1;
  min-height: 0;
}
.data__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-raised);
  font-size: 11px;
  flex: 0 0 auto;
}
.data__page {
  font-variant-numeric: tabular-nums;
  min-width: 150px;
  text-align: center;
}
.data__pagesize {
  width: 78px;
  height: 24px;
}
.data__sql {
  max-width: 40%;
  font-size: 10px;
}
</style>
