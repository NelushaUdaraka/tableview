<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CellValue, ColumnMeta, QueryExecutionResult } from '@shared/types'
import DataGrid from './DataGrid.vue'
import ContextMenu, { type MenuEntry } from './ContextMenu.vue'
import { exportRows } from '@shared/export'
import { useToastStore } from '../stores/toasts'
import { api } from '../lib/api'

const props = defineProps<{
  result: QueryExecutionResult | null
  running: boolean
}>()

const emit = defineEmits<{ (event: 'export', columns: ColumnMeta[], rows: CellValue[][]): void }>()

const toasts = useToastStore()
const activeIndex = ref(0)
const showMessages = ref(false)
const menu = ref<{ x: number; y: number; row: number; col: number } | null>(null)
const grid = ref<InstanceType<typeof DataGrid> | null>(null)

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

watch(panels, () => {
  activeIndex.value = 0
  // Surface messages automatically when there is nothing else to show.
  showMessages.value = panels.value.length === 0 && (messages.value.length > 0 || errors.value.length > 0)
})

const menuItems: MenuEntry[] = [
  { label: 'Copy cell', action: 'copy-cell' },
  { label: 'Copy row', action: 'copy-row' },
  { separator: true, label: '' },
  { label: 'Copy all as CSV', action: 'copy-csv' },
  { label: 'Copy all as JSON', action: 'copy-json' },
  { label: 'Copy all as INSERTs', action: 'copy-sql' },
  { separator: true, label: '' },
  { label: 'Export…', action: 'export' }
]

async function onMenuSelect(action: string): Promise<void> {
  const panel = active.value
  if (!panel) return

  if (action === 'copy-cell') return void grid.value?.copySelection(false)
  if (action === 'copy-row') return void grid.value?.copySelection(true)
  if (action === 'export') return emit('export', panel.columns, panel.rows)

  const format = action === 'copy-csv' ? 'csv' : action === 'copy-json' ? 'json' : 'sql'
  const text = exportRows(panel.columns, panel.rows, {
    format,
    includeHeader: true,
    tableName: 'exported'
  })
  await api.copyToClipboard(text)
  toasts.info(`Copied ${panel.rows.length} rows`)
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

      <DataGrid
        v-else-if="active"
        ref="grid"
        :columns="active.columns"
        :rows="active.rows"
        :loading="running"
        empty-message="The statement returned no rows"
        @row-context="menu = { x: $event.x, y: $event.y, row: $event.rowIndex, col: $event.columnIndex }"
      />

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
