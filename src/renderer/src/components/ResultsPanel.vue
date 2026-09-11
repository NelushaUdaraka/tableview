<script setup lang="ts">
/**
 * The query's results: one tab per result set, the server's messages, and the
 * selected row's fields down the side.
 *
 * A result set cannot be re-fetched in a different order, so sorting here
 * reorders the rows already on screen. Nothing in this panel is editable — a
 * statement's output has no rows to write back to.
 */
import { computed, ref, watch } from 'vue'
import type { CellValue, ColumnMeta, QueryExecutionResult } from '@shared/types'
import DataGrid from './DataGrid.vue'
import ContextMenu, { type MenuEntry } from './ContextMenu.vue'
import RowDetailPanel, { type RowField } from './RowDetailPanel.vue'
import SplitPane from './SplitPane.vue'
import { exportRows } from '@shared/export'
import { columnMenuItems } from '../lib/columnMenu'
import { sortRows, type SortDirection } from '../lib/sortRows'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toasts'
import { api } from '../lib/api'

const props = defineProps<{
  result: QueryExecutionResult | null
  running: boolean
}>()

const emit = defineEmits<{ (event: 'export', columns: ColumnMeta[], rows: CellValue[][]): void }>()

const settings = useSettingsStore()
const toasts = useToastStore()
const activeIndex = ref(0)
const showMessages = ref(false)
const menu = ref<{ kind: 'row' | 'header'; x: number; y: number; row: number; col: number } | null>(
  null
)
const grid = ref<InstanceType<typeof DataGrid> | null>(null)
const selection = ref<{ rowIndex: number; columnIndex: number } | null>(null)

/** Flattens every batch's result sets into one tab strip. */
interface Panel {
  key: string
  label: string
  columns: ColumnMeta[]
  rows: CellValue[][]
  rowCount: number
  truncated: boolean
  statementIndex: number
}

const panels = computed<Panel[]>(() => {
  if (!props.result) return []
  const out: Panel[] = []
  props.result.statements.forEach((statement, statementIndex) => {
    statement.resultSets.forEach((set, setIndex) => {
      out.push({
        key: `${statementIndex}-${setIndex}`,
        label: `Result ${out.length + 1}`,
        columns: set.columns,
        rows: set.rows,
        rowCount: set.rowCount,
        truncated: set.truncated,
        statementIndex
      })
    })
  })
  return out
})

const messages = computed(() =>
  (props.result?.statements ?? []).flatMap((statement) => statement.messages)
)

const errors = computed(() =>
  (props.result?.statements ?? [])
    .map((statement) => statement.error)
    .filter((error): error is NonNullable<typeof error> => Boolean(error))
)

const rowsAffected = computed(() =>
  (props.result?.statements ?? []).flatMap((statement) => statement.rowsAffected)
)

const totalAffected = computed(() => rowsAffected.value.reduce((sum, n) => sum + n, 0))

const active = computed(() => panels.value[activeIndex.value] ?? null)

// --- ordering ---------------------------------------------------------------

/** Client-side, and one column at a time: there is no query to re-issue. */
const sort = ref<{ column: string; direction: SortDirection } | null>(null)

/** The active set's rows in the order the grid is showing them. */
const rows = computed<CellValue[][]>(() => {
  const panel = active.value
  if (!panel) return []
  const current = sort.value
  if (!current) return panel.rows
  const index = panel.columns.findIndex((column) => column.name === current.column)
  return index < 0 ? panel.rows : sortRows(panel.rows, index, current.direction)
})

/** What the grid's header draws its arrow from. */
const gridSorts = computed(() => (sort.value ? [sort.value] : []))

/** Click a header: ascending, then descending, then back to the server's order. */
function toggleSort(column: string): void {
  const current = sort.value
  sort.value =
    current?.column !== column
      ? { column, direction: 'asc' }
      : current.direction === 'asc'
        ? { column, direction: 'desc' }
        : null
}

function sortByColumn(column: string, direction: SortDirection): void {
  sort.value = { column, direction }
}

watch(panels, () => {
  activeIndex.value = 0
  // Surface messages automatically when there is nothing else to show.
  showMessages.value = panels.value.length === 0 && (messages.value.length > 0 || errors.value.length > 0)
})

// A different result set has different columns, so an order named on the last
// one means nothing here.
watch(activeIndex, () => {
  sort.value = null
})

// --- the selected row -------------------------------------------------------

/**
 * The row panel follows the same setting the table browser's does, so Ctrl+I
 * and the View menu mean one thing across the app rather than one per view.
 */
const showRowPanel = computed(() => settings.settings.showRowPanel)
const rowPanelWidth = ref(settings.settings.rowPanelWidth)

// Dragging the divider emits on every mouse move; only the resting width is
// worth a write to disk.
let widthTimer: ReturnType<typeof setTimeout> | null = null
watch(rowPanelWidth, (width) => {
  if (widthTimer) clearTimeout(widthTimer)
  widthTimer = setTimeout(() => void settings.update({ rowPanelWidth: width }), 500)
})

/**
 * The selected row as fields.
 *
 * Read-only throughout: a result set is the output of a statement, with no
 * table behind it to write a change back to.
 */
const rowFields = computed<RowField[]>(() => {
  const panel = active.value
  const current = selection.value
  if (!panel || !current) return []
  const row = rows.value[current.rowIndex]
  if (!row) return []
  return panel.columns.map((column, index) => ({
    column,
    value: row[index] ?? null,
    edited: false,
    isPrimaryKey: false
  }))
})

const rowLabel = computed(() => {
  const current = selection.value
  if (!current || !rows.value[current.rowIndex]) return ''
  return `${(current.rowIndex + 1).toLocaleString()} of ${rows.value.length.toLocaleString()}`
})

function toggleRowPanel(): void {
  void settings.update({ showRowPanel: !settings.settings.showRowPanel })
}

/** Opens the panel on a named row, rather than toggling it. */
function showRowDetails(rowIndex: number, columnIndex: number): void {
  grid.value?.selectCell(rowIndex, columnIndex)
  if (!settings.settings.showRowPanel) void settings.update({ showRowPanel: true })
}

/** Moves the grid's selection, which moves the panel with it. */
function moveSelection(delta: number): void {
  const current = selection.value
  if (!current) return
  const next = current.rowIndex + delta
  if (next < 0 || next >= rows.value.length) return
  grid.value?.selectCell(next, current.columnIndex)
}

// --- menus ------------------------------------------------------------------

const rowMenuItems: MenuEntry[] = [
  { label: 'Copy cell', action: 'copy-cell', hint: 'Ctrl+C' },
  { label: 'Copy row', action: 'copy-row', hint: 'Ctrl+Shift+C' },
  { separator: true, label: '' },
  { label: 'Copy all as CSV', action: 'copy-csv' },
  { label: 'Copy all as JSON', action: 'copy-json' },
  { label: 'Copy all as INSERTs', action: 'copy-sql' },
  { separator: true, label: '' },
  { label: 'View row details', action: 'row-details', hint: 'Ctrl+I' },
  { label: 'Export…', action: 'export' }
]

const headerMenuItems = computed<MenuEntry[]>(() => {
  const column = menu.value ? active.value?.columns[menu.value.col] : undefined
  if (!column) return []
  return columnMenuItems({
    column: column.name,
    direction: sort.value?.column === column.name ? sort.value.direction : null,
    anySort: sort.value !== null,
    // Nothing to filter: the rows are whatever the statement returned.
    filterable: false,
    filtered: false
  })
})

const menuItems = computed<MenuEntry[]>(() =>
  menu.value?.kind === 'header' ? headerMenuItems.value : rowMenuItems
)

async function onColumnMenuSelect(action: string, columnIndex: number): Promise<void> {
  const column = active.value?.columns[columnIndex]
  if (!column) return

  switch (action) {
    case 'sort-asc':
      sortByColumn(column.name, 'asc')
      break
    case 'sort-desc':
      sortByColumn(column.name, 'desc')
      break
    case 'sort-clear':
      sort.value = null
      break
    case 'copy-name':
      await api.copyToClipboard(column.name)
      toasts.info(`Copied “${column.name}”`)
      break
    case 'fit-column':
      grid.value?.autoFit(columnIndex)
      break
    case 'fit-all':
      grid.value?.autoFitAll()
      break
  }
}

async function onMenuSelect(action: string): Promise<void> {
  const target = menu.value
  const panel = active.value
  if (!target || !panel) return
  if (target.kind === 'header') return onColumnMenuSelect(action, target.col)

  if (action === 'copy-cell') return void grid.value?.copySelection(false)
  if (action === 'copy-row') return void grid.value?.copySelection(true)
  if (action === 'row-details') return showRowDetails(target.row, target.col)
  // What is exported is what is on screen, in the order it is shown.
  if (action === 'export') return emit('export', panel.columns, rows.value)

  const format = action === 'copy-csv' ? 'csv' : action === 'copy-json' ? 'json' : 'sql'
  const text = exportRows(panel.columns, rows.value, {
    format,
    includeHeader: true,
    tableName: 'exported'
  })
  await api.copyToClipboard(text)
  toasts.info(`Copied ${rows.value.length} rows`)
}

function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
</script>

<template>
  <div class="results">
    <div class="results__bar">
      <div class="results__tabs">
        <button
          v-for="(panel, index) in panels"
          :key="panel.key"
          class="results__tab"
          :class="{ 'results__tab--active': !showMessages && activeIndex === index }"
          @click="((activeIndex = index), (showMessages = false))"
        >
          {{ panel.label }}
          <span class="results__tab-count">{{ panel.rowCount }}</span>
        </button>
        <button
          v-if="messages.length || errors.length"
          class="results__tab"
          :class="{
            'results__tab--active': showMessages,
            'results__tab--error': errors.length > 0
          }"
          @click="showMessages = true"
        >
          Messages
          <span class="results__tab-count">{{ messages.length }}</span>
        </button>
      </div>

      <div class="results__meta">
        <span v-if="running" class="results__cell results__running">
          <span class="spinner"></span> Running…
        </span>
        <template v-else-if="result">
          <span
            v-if="active?.truncated"
            class="results__cell results__warn"
            title="Row cap reached"
          >
            showing {{ active.rows.length }} of {{ active.rowCount }}
          </span>
          <span v-if="rowsAffected.length" class="results__cell">{{ totalAffected }} affected</span>
          <span class="results__cell results__cell--strong">
            {{ durationLabel(result.totalDurationMs) }}
          </span>
        </template>
        <button
          class="results__toggle"
          :class="{ 'results__toggle--on': showRowPanel }"
          :title="`${showRowPanel ? 'Hide' : 'Show'} the selected row beside the results (Ctrl+I)`"
          :aria-pressed="showRowPanel"
          @click="toggleRowPanel"
        >
          ▤ Row details
        </button>
      </div>
    </div>

    <div class="results__body">
      <div v-if="showMessages" class="messages">
        <div v-for="(error, index) in errors" :key="`e-${index}`" class="message message--error">
          <div class="message__title">
            Msg {{ error.number ?? '' }}<template v-if="error.state">, State {{ error.state }}</template>
            <template v-if="error.lineNumber">, Line {{ error.lineNumber }}</template>
          </div>
          <div class="message__text selectable">{{ error.message }}</div>
          <div v-if="error.procName" class="message__meta">in {{ error.procName }}</div>
        </div>
        <div v-for="(message, index) in messages" :key="`m-${index}`" class="message">
          <div class="message__text selectable">{{ message.message }}</div>
        </div>
        <div v-if="!messages.length && !errors.length" class="empty-state">
          <div class="empty-state__title">No messages</div>
        </div>
      </div>

      <SplitPane
        v-else-if="active"
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
            :columns="active.columns"
            :rows="rows"
            :loading="running"
            :sorts="gridSorts"
            empty-message="The statement returned no rows"
            @sort="toggleSort"
            @selection="selection = $event"
            @row-context="
              menu = {
                kind: 'row',
                x: $event.x,
                y: $event.y,
                row: $event.rowIndex,
                col: $event.columnIndex
              }
            "
            @header-context="
              menu = { kind: 'header', x: $event.x, y: $event.y, row: -1, col: $event.columnIndex }
            "
          />
        </template>

        <template #second>
          <RowDetailPanel
            v-if="showRowPanel"
            :fields="rowFields"
            :label="rowLabel"
            :selected-index="selection?.columnIndex ?? null"
            :has-previous="!!selection && selection.rowIndex > 0"
            :has-next="!!selection && selection.rowIndex < rows.length - 1"
            @select="selection && grid?.selectCell(selection.rowIndex, $event)"
            @move="moveSelection"
            @close="toggleRowPanel"
          />
        </template>
      </SplitPane>

      <div v-else-if="running" class="empty-state">
        <span class="spinner"></span>
        <div class="empty-state__title">Running…</div>
      </div>

      <div v-else-if="result" class="empty-state">
        <div class="empty-state__title">Statement completed</div>
        <p v-if="rowsAffected.length">{{ totalAffected }} rows affected</p>
      </div>

      <div v-else class="empty-state">
        <div class="empty-state__title">No results yet</div>
        <p>Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to run the query.</p>
      </div>
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
.results {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-surface);
}
.results__bar {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  height: var(--h-tabstrip);
  border-bottom: var(--rule) solid var(--border-strong);
  background: var(--bg-app);
  flex: 0 0 auto;
}
.results__tabs {
  display: flex;
  height: 100%;
  overflow-x: auto;
}
.results__tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  cursor: pointer;
  white-space: nowrap;
}
.results__tab + .results__tab {
  border-left: 1px solid var(--border-subtle);
}
.results__tab:hover {
  color: var(--text-primary);
}
.results__tab--active {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.results__tab--error {
  color: var(--danger);
}
.results__tab-count {
  padding: 1px 6px;
  border-radius: 0;
  background: var(--bg-raised);
  font-size: 10px;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
/* The run's numbers get ruled cells of their own, like the status bar. */
.results__meta {
  display: flex;
  align-items: stretch;
  white-space: nowrap;
}
.results__cell {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 12px;
  border-left: 1px solid var(--border-strong);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}
.results__cell--strong {
  padding: 0 14px;
  color: var(--text-secondary);
}
.results__warn {
  color: var(--warning);
}
/* Sits in the run's strip of ruled cells rather than beside it, so the bar
   stays one row of cells. */
.results__toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 12px;
  border: none;
  border-left: 1px solid var(--border-strong);
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  white-space: nowrap;
  cursor: pointer;
}
.results__toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.results__toggle--on {
  color: var(--text-primary);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.results__body {
  flex: 1;
  min-height: 0;
}

.messages {
  height: 100%;
  overflow: auto;
}
.message {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  box-shadow: inset 3px 0 0 var(--border-strong);
  background: transparent;
  font-family: var(--font-mono);
  font-size: 12px;
}
.message--error {
  box-shadow: inset 3px 0 0 var(--danger);
}
.message__title {
  font-weight: 700;
  color: var(--danger);
  margin-bottom: 4px;
}
.message__text {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
}
.message__meta {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-dim);
}
kbd {
  padding: 3px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
</style>
