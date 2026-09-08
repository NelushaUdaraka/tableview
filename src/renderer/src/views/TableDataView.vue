<script setup lang="ts">
/**
 * Table browser with staged editing.
 *
 * Edits are held locally until "Apply", then sent as one change set that the
 * main process runs inside a transaction. Rows are addressed by their primary
 * key; a table without one falls back to matching on every column, which the
 * banner warns about because it can match more rows than intended.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import type {
  CellValue,
  ColumnMeta,
  TableChangeSet,
  TableColumn,
  TableFilter,
  TableSort,
  TableStructure
} from '@shared/types'
import BaseModal from '../components/BaseModal.vue'
import DataGrid, { type RowState } from '../components/DataGrid.vue'
import FilterBuilder from '../components/FilterBuilder.vue'
import ContextMenu, { type MenuEntry } from '../components/ContextMenu.vue'
import RowDetailPanel, { type RowField } from '../components/RowDetailPanel.vue'
import SplitPane from '../components/SplitPane.vue'
import TableViewSwitch from '../components/TableViewSwitch.vue'
import { exportRows } from '@shared/export'
import { foreignKeyFilters, foreignKeyTargets } from '@shared/foreignKeys'
import { useSettingsStore } from '../stores/settings'
import { useSchemaStore } from '../stores/schema'
import { useTabStore } from '../stores/tabs'
import { useToastStore } from '../stores/toasts'
import { useConnectionStore } from '../stores/connections'
import { useCredentialsStore } from '../stores/credentials'
import type { TableTab } from '../stores/tabs'
import { api } from '../lib/api'

const props = defineProps<{ tab: TableTab }>()
const emit = defineEmits<{
  (event: 'export', columns: ColumnMeta[], rows: CellValue[][], name: string): void
  (event: 'open-related', schema: string, table: string, filters: TableFilter[]): void
}>()

const settings = useSettingsStore()
const schemaStore = useSchemaStore()
const tabs = useTabStore()
const toasts = useToastStore()
const connections = useConnectionStore()
const credentials = useCredentialsStore()

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
const selection = ref<{ rowIndex: number; columnIndex: number } | null>(null)

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

const pageRange = computed(() => {
  const from = allRows.value.length === 0 ? 0 : offset.value + 1
  const to = offset.value + loadedRows.value.length
  return `${from.toLocaleString()}–${to.toLocaleString()}`
})

const pageTotal = computed(() =>
  totalRows.value === null ? '?' : totalRows.value.toLocaleString()
)

/** The row count as the command bar states it, beside the table's name. */
const rowCountLabel = computed(() =>
  totalRows.value === null ? '' : `${totalRows.value.toLocaleString()} rows`
)

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

/** Drops one staged cell edit, leaving the rest of the row staged. */
function revertCell(rowIndex: number, columnIndex: number): void {
  delete edits[`${rowIndex}:${columnIndex}`]
}

type PendingChoice = 'apply' | 'discard' | 'cancel'

/**
 * Asks what to do with staged edits that are about to be lost.
 *
 * Reloading the table replaces the rows the edits are keyed against, so they
 * cannot survive it — but silently dropping them is how a page of retyped
 * values disappears on a stray Refresh.
 */
const pendingPrompt = ref<{ resolve: (choice: PendingChoice) => void } | null>(null)

function askAboutPendingEdits(): Promise<PendingChoice> {
  return new Promise((resolve) => {
    pendingPrompt.value = { resolve }
  })
}

function answerPendingPrompt(choice: PendingChoice): void {
  const prompt = pendingPrompt.value
  pendingPrompt.value = null
  prompt?.resolve(choice)
}

/** Runs `action` once the staged edits have been applied or dropped. */
async function withPendingEdits(action: () => void | Promise<void>): Promise<void> {
  if (pendingCount.value > 0) {
    const choice = await askAboutPendingEdits()
    if (choice === 'cancel') return
    if (choice === 'apply') {
      if (!(await apply())) return
    } else {
      discard()
    }
  }
  await action()
}

/** The tab store asks this before leaving or closing this table's tab. */
async function confirmLeave(): Promise<boolean> {
  if (pendingCount.value === 0) return true
  const choice = await askAboutPendingEdits()
  if (choice === 'cancel') return false
  if (choice === 'apply') return apply()
  discard()
  return true
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
    // A session that ran out mid-browse is fixable in place; retry this load.
    const connection = connections.saved.find((entry) => entry.id === props.tab.connectionId)
    if (!credentials.offerRefresh(connection, error, () => load(resetOffset))) {
      toasts.fromError('Could not load the table', error)
    }
  } finally {
    loading.value = false
  }
}

onBeforeUnmount(() => {
  tabs.setLeaveGuard(null)
  // A dialog left waiting would keep its caller pending forever.
  if (pendingPrompt.value) answerPendingPrompt('cancel')
})

/** Filters carried on the tab, e.g. from following a foreign key into it. */
function applyTabFilters(): boolean {
  const incoming = props.tab.filters
  if (!incoming || incoming.length === 0) return false
  filters.value = incoming.map((filter) => ({ ...filter }))
  filterMode.value = 'builder'
  rawWhere.value = ''
  // Show them: a table that opens holding three rows should say why.
  showFilters.value = true
  return true
}

onMounted(async () => {
  // A remount starts with no staged edits, so the tab's badge must not claim
  // any left over from the last time this table was open.
  tabs.update<TableTab>(props.tab.id, { pendingEdits: 0 })
  // Leaving this tab unmounts the view and takes the staged edits with it, so
  // the store asks here first.
  tabs.setLeaveGuard(confirmLeave)
  await loadStructure()
  // A primary key gives a stable default order.
  const key = structure.value?.primaryKey ?? []
  sorts.value = key.length ? key.map((column) => ({ column, direction: 'asc' as const })) : []
  const filtered = applyTabFilters()
  await load()
  // Arriving by way of a foreign key means the row that was asked for is the
  // one now on screen; put it straight into the panel.
  if (filtered) await selectFirstRow()
})

// Reopening a table reuses its tab, so new filters arrive as a revision bump
// rather than a fresh mount.
watch(
  () => props.tab.filterRevision,
  async () => {
    await withPendingEdits(async () => {
      if (!applyTabFilters()) return
      await load(true)
      await selectFirstRow()
    })
  }
)

// --- the selected row -------------------------------------------------------

const showRowPanel = computed(() => settings.settings.showRowPanel)
const rowPanelWidth = ref(settings.settings.rowPanelWidth)

/**
 * Selects the first row once the grid has settled.
 *
 * Replacing the columns resets the grid's selection, and that watcher runs on
 * the flush after `load` resolves — so this has to wait for it, or it would
 * select a row and then have the reset clear it again.
 */
async function selectFirstRow(): Promise<void> {
  await nextTick()
  if (allRows.value.length > 0) grid.value?.selectCell(0, 0)
}

function toggleRowPanel(): void {
  void settings.update({ showRowPanel: !settings.settings.showRowPanel })
}

// Dragging the divider emits on every mouse move; only the resting width is
// worth a write to disk.
let widthTimer: ReturnType<typeof setTimeout> | null = null
watch(rowPanelWidth, (width) => {
  if (widthTimer) clearTimeout(widthTimer)
  widthTimer = setTimeout(() => void settings.update({ rowPanelWidth: width }), 500)
})

/** Column index -> the foreign key it participates in. */
const foreignKeys = computed(() =>
  foreignKeyTargets(columns.value, structure.value?.foreignKeys ?? [])
)

/** The same map flattened to labels, which is all the grid needs. */
const foreignKeyLabels = computed<Record<number, string>>(() =>
  Object.fromEntries(
    Object.entries(foreignKeys.value).map(([index, target]) => [index, target.label])
  )
)

/** A row's values as they stand, staged edits included. */
function mergedRow(rowIndex: number): CellValue[] | null {
  const row = allRows.value[rowIndex]
  if (!row) return null
  return columns.value.map((_, index) => {
    const key = `${rowIndex}:${index}`
    return key in edits ? edits[key] : (row[index] ?? null)
  })
}

const rowFields = computed<RowField[]>(() => {
  const current = selection.value
  if (!current) return []
  const row = allRows.value[current.rowIndex]
  if (!row) return []

  return columns.value.map((column, index) => {
    const key = `${current.rowIndex}:${index}`
    const edited = key in edits
    return {
      column,
      value: edited ? edits[key] : (row[index] ?? null),
      edited,
      isPrimaryKey: primaryKey.value.includes(column.name),
      foreignKey: foreignKeyLabels.value[index]
    }
  })
})

const rowLabel = computed(() => {
  const current = selection.value
  if (!current || !allRows.value[current.rowIndex]) return ''
  if (current.rowIndex >= loadedRows.value.length) {
    return `new ${current.rowIndex - loadedRows.value.length + 1}`
  }
  const total = totalRows.value ?? allRows.value.length
  return `${(offset.value + current.rowIndex + 1).toLocaleString()} of ${total.toLocaleString()}`
})

const rowState = computed<RowState>(() =>
  selection.value ? (rowStates.value[selection.value.rowIndex] ?? 'normal') : 'normal'
)

/** Moves the grid's selection, which moves the panel with it. */
function moveSelection(delta: number): void {
  const current = selection.value
  if (!current) return
  const next = current.rowIndex + delta
  if (next < 0 || next >= allRows.value.length) return
  grid.value?.selectCell(next, current.columnIndex)
}

function editSelectedRow(columnIndex: number, value: CellValue): void {
  if (!selection.value) return
  onEdit(selection.value.rowIndex, columnIndex, value)
}

/**
 * Opens the row a foreign key points at, in the referenced table's own tab.
 *
 * The filters are built from the values as they are displayed — a staged edit
 * included — because that is the row the arrow appears to point at.
 */
function followKey(rowIndex: number, columnIndex: number): void {
  const target = foreignKeys.value[columnIndex]
  const row = mergedRow(rowIndex)
  if (!target || !row) return

  const related = foreignKeyFilters(target, columns.value, row)
  if (!related) {
    toasts.info(
      'That reference cannot be followed',
      'The value is NULL, or its type has no text form to filter on.'
    )
    return
  }
  emit('open-related', target.schema, target.table, related)
}

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
  void withPendingEdits(() => load(true))
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

/** Resolves true when the staged changes reached the server. */
async function apply(): Promise<boolean> {
  if (pendingCount.value === 0) return true
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
    if (!confirm(`Apply ${summary} to ${props.tab.schema}.${props.tab.table}?${warning}`)) {
      return false
    }
  }

  applying.value = true
  try {
    const applied = await api.applyChanges(changeSet)
    toasts.success(
      'Changes applied',
      `${applied.inserted} inserted, ${applied.updated} updated, ${applied.deleted} deleted`
    )
    await load()
    return true
  } catch (error) {
    toasts.fromError('Could not apply the changes — nothing was committed', error)
    return false
  } finally {
    applying.value = false
  }
}

function goToPage(delta: number): void {
  void withPendingEdits(() => {
    offset.value = Math.max(0, offset.value + delta * pageSize.value)
    return load()
  })
}

const menuItems = computed<MenuEntry[]>(() => [
  { label: 'Copy cell', action: 'copy-cell' },
  { label: 'Copy row', action: 'copy-row' },
  ...(menu.value && foreignKeys.value[menu.value.col]
    ? [
        { separator: true, label: '' },
        {
          label: `Go to ${foreignKeys.value[menu.value.col].schema}.${foreignKeys.value[menu.value.col].table}`,
          action: 'follow-key'
        }
      ]
    : []),
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
    case 'follow-key':
      followKey(target.row, target.col)
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
  refresh: () => withPendingEdits(() => load()),
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
      <TableViewSwitch :tab="tab" />

      <span class="data__name mono truncate">
        {{ tab.schema }}.<strong>{{ tab.table }}</strong>
      </span>
      <span v-if="rowCountLabel" class="data__rows mono">{{ rowCountLabel }}</span>

      <div class="data__spacer"></div>

      <button class="btn" :disabled="loading" @click="withPendingEdits(() => load())">
        ⟳ Refresh
      </button>
      <button
        class="btn"
        :class="{ 'btn--armed': showFilters || filters.length > 0 || !!rawWhere }"
        @click="showFilters = !showFilters"
      >
        Filter
        <span v-if="filters.length || rawWhere" class="data__dot"></span>
      </button>
      <button
        class="btn"
        :class="{ 'btn--armed': showRowPanel }"
        title="Show the selected row beside the grid (Ctrl+I)"
        @click="toggleRowPanel"
      >
        Row
      </button>

      <template v-if="editable">
        <div class="divider-v"></div>
        <button class="btn" @click="addRow">+ Row</button>
        <button v-if="pendingCount > 0" class="btn btn--muted" :disabled="applying" @click="discard">
          Discard
        </button>
        <button
          v-if="pendingCount > 0"
          class="btn btn--primary"
          :disabled="applying"
          @click="apply"
        >
          <span v-if="applying" class="spinner"></span>
          Apply
          <span class="seg__count">{{ pendingCount }}</span>
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
      @apply="withPendingEdits(() => load(true))"
    />

    <div v-if="editable && !hasPrimaryKey" class="data__warning">
      This table has no primary key. Edits match rows on every column, so a duplicate row would be
      changed more than once.
    </div>

    <div class="data__grid">
      <SplitPane
        v-model="rowPanelWidth"
        direction="horizontal"
        pane="second"
        :min="220"
        :max="960"
        :collapsed="!showRowPanel"
      >
        <template #first>
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
            :foreign-keys="foreignKeyLabels"
            empty-message="No rows match"
            @edit="onEdit"
            @revert-cell="revertCell"
            @sort="onSort"
            @selection="selection = $event"
            @follow-key="followKey($event.rowIndex, $event.columnIndex)"
            @row-context="menu = { x: $event.x, y: $event.y, row: $event.rowIndex, col: $event.columnIndex }"
          />
        </template>

        <template #second>
          <RowDetailPanel
            v-if="showRowPanel"
            :fields="rowFields"
            :label="rowLabel"
            :editable="editable"
            :state="rowState"
            :selected-index="selection?.columnIndex ?? null"
            :has-previous="!!selection && selection.rowIndex > 0"
            :has-next="!!selection && selection.rowIndex < allRows.length - 1"
            @edit="editSelectedRow"
            @revert="selection && revertCell(selection.rowIndex, $event)"
            @follow-key="selection && followKey(selection.rowIndex, $event)"
            @select="selection && grid?.selectCell(selection.rowIndex, $event)"
            @move="moveSelection"
            @close="toggleRowPanel"
          />
        </template>
      </SplitPane>
    </div>

    <div class="data__foot">
      <button class="btn btn--sm" :disabled="!canPrevious || loading" @click="goToPage(-1)">
        ‹ Prev
      </button>
      <span class="data__page num">{{ pageRange }} <span class="dim">of</span> {{ pageTotal }}</span>
      <button class="btn btn--sm" :disabled="!canNext || loading" @click="goToPage(1)">
        Next ›
      </button>

      <select
        v-model.number="pageSize"
        class="select select--sm data__pagesize"
        @change="withPendingEdits(() => load(true))"
      >
        <option :value="50">50</option>
        <option :value="100">100</option>
        <option :value="200">200</option>
        <option :value="500">500</option>
        <option :value="1000">1000</option>
      </select>

      <div class="data__spacer"></div>
      <span class="dim mono data__ms">{{ durationMs }} ms</span>
      <div class="divider-v data__foot-rule"></div>
      <span class="dim mono truncate data__sql" :title="lastSql">
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

    <!-- Reloading rekeys every staged edit, so this is the last chance to keep them. -->
    <BaseModal
      v-if="pendingPrompt"
      kicker="Unsaved changes"
      title="This table has staged edits"
      :subtitle="`${tab.schema}.${tab.table}`"
      width="480px"
      @close="answerPendingPrompt('cancel')"
    >
      <p class="prompt__text">
        {{ pendingCount }} staged {{ pendingCount === 1 ? 'change has' : 'changes have' }} not been
        written to the database. Reloading the table would discard
        {{ pendingCount === 1 ? 'it' : 'them' }}.
      </p>

      <template #footer>
        <button class="btn" @click="answerPendingPrompt('cancel')">Cancel</button>
        <div class="prompt__spacer"></div>
        <button class="btn btn--danger" @click="answerPendingPrompt('discard')">Discard</button>
        <button class="btn btn--primary" @click="answerPendingPrompt('apply')">
          Apply and continue
        </button>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.prompt__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.prompt__spacer {
  flex: 1;
}

.data {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
/* One command bar: the view switch, what you are looking at, and what you can
   do to it. The Data/Structure strip used to sit above this. */
.data__toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--h-commandbar);
  padding: 0 12px;
  border-bottom: var(--rule) solid var(--border-strong);
  background: var(--bg-surface);
  flex: 0 0 auto;
}
.data__name {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--text-primary);
}
.data__name strong {
  font-weight: 700;
}
.data__rows {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-dim);
}
.data__spacer {
  flex: 1;
}
.data__toolbar .btn {
  flex: 0 0 auto;
}
.data__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  background: var(--accent);
}
.data__warning {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-strong);
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--text-primary);
  font-size: 12px;
}
.data__grid {
  flex: 1;
  min-height: 0;
}
.data__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--h-gridheader);
  padding: 0 12px;
  border-top: var(--rule) solid var(--border-strong);
  background: var(--bg-app);
  font-size: 11px;
  flex: 0 0 auto;
}
.data__page {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.data__pagesize {
  width: auto;
  min-width: 72px;
  padding-right: 24px;
  font-size: 12px;
}
.data__ms {
  flex: 0 0 auto;
  font-size: 11px;
}
.data__foot-rule {
  height: 16px;
}
.data__sql {
  max-width: 44%;
  font-size: 11px;
}
</style>
