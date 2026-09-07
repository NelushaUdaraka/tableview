<script setup lang="ts">
/**
 * Virtualised result grid.
 *
 * Rows are a fixed height so the visible window can be computed arithmetically
 * rather than measured — that keeps scrolling smooth on result sets of tens of
 * thousands of rows. The component stays presentational: it renders the row
 * state the parent hands it and emits edits rather than owning them.
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance
} from 'vue'
import type { CellValue, ColumnMeta } from '@shared/types'
import { formatCellForDisplay, formatCellFull, parseCellInput } from '@shared/serialize'
import { api } from '../lib/api'

export type RowState = 'normal' | 'inserted' | 'deleted'

const props = withDefaults(
  defineProps<{
    columns: ColumnMeta[]
    rows: CellValue[][]
    editable?: boolean
    loading?: boolean
    rowStates?: RowState[]
    /** Keyed `rowIndex:columnIndex`. */
    editedCells?: Record<string, CellValue>
    sorts?: { column: string; direction: 'asc' | 'desc' }[]
    /** Row number of the first row, for paged views. */
    rowOffset?: number
    primaryKey?: string[]
    emptyMessage?: string
  }>(),
  {
    editable: false,
    loading: false,
    rowStates: () => [],
    editedCells: () => ({}),
    sorts: () => [],
    rowOffset: 0,
    primaryKey: () => [],
    emptyMessage: 'No rows'
  }
)

const emit = defineEmits<{
  (event: 'edit', rowIndex: number, columnIndex: number, value: CellValue): void
  (event: 'sort', column: string, additive: boolean): void
  (event: 'delete-rows', rowIndexes: number[]): void
  (event: 'row-context', payload: { rowIndex: number; columnIndex: number; x: number; y: number }): void
  (event: 'selection', payload: { rowIndex: number; columnIndex: number } | null): void
}>()

const ROW_HEIGHT = 26
const OVERSCAN = 8
const MIN_WIDTH = 60
const MAX_AUTO_WIDTH = 420

const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(600)
const widths = ref<number[]>([])
const selected = ref<{ row: number; col: number } | null>(null)
const editing = ref<{ row: number; col: number } | null>(null)
const editValue = ref('')
const editInput = ref<HTMLInputElement | null>(null)

/**
 * A plain `ref="editInput"` would not work here: Vue collects template refs
 * declared inside a `v-for` into an array, so `editInput.value.focus()` would
 * never run and the cell editor would open unfocused. A function ref binds the
 * single element that `v-if` actually renders.
 */
function bindEditInput(element: Element | ComponentPublicInstance | null): void {
  editInput.value = (element as HTMLInputElement | null) ?? null
}

const totalHeight = computed(() => props.rows.length * ROW_HEIGHT)

const startIndex = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN)
)
const endIndex = computed(() =>
  Math.min(
    props.rows.length,
    Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + OVERSCAN
  )
)

interface VisibleRow {
  index: number
  cells: CellValue[]
  state: RowState
  top: number
}

const visibleRows = computed<VisibleRow[]>(() => {
  const out: VisibleRow[] = []
  for (let i = startIndex.value; i < endIndex.value; i += 1) {
    out.push({
      index: i,
      cells: props.rows[i],
      state: props.rowStates[i] ?? 'normal',
      top: i * ROW_HEIGHT
    })
  }
  return out
})

const CELL_CHAR_PX = 7.6      // 12px monospace
const HEADER_NAME_PX = 7.2    // 12px bold UI font
const HEADER_TYPE_PX = 5.6    // 10px monospace type label
const PK_BADGE_PX = 26
const SORT_ARROW_PX = 16
const CELL_PADDING_PX = 24

/**
 * The header carries more than the column name — the type label, an optional
 * PK badge and a sort arrow — so width has to be the larger of what the header
 * needs and what the sampled values need, or headers end up truncated.
 */
function headerWidth(column: ColumnMeta): number {
  const isKey = props.primaryKey.includes(column.name)
  const isSorted = props.sorts.some((sort) => sort.column === column.name)
  return (
    column.name.length * HEADER_NAME_PX +
    column.dataType.length * HEADER_TYPE_PX +
    (isKey ? PK_BADGE_PX : 0) +
    (isSorted ? SORT_ARROW_PX : 0) +
    CELL_PADDING_PX
  )
}

/** Estimates a starting width per column from its header and first rows. */
function measureColumns(): void {
  const sample = props.rows.slice(0, 40)
  widths.value = props.columns.map((column, index) => {
    let longestValue = 0
    for (const row of sample) {
      const text = formatCellForDisplay(row?.[index] ?? null, column.dataType)
      longestValue = Math.max(longestValue, (text ?? 'NULL').length)
    }
    const dataWidth = longestValue * CELL_CHAR_PX + CELL_PADDING_PX
    return Math.min(MAX_AUTO_WIDTH, Math.max(MIN_WIDTH, dataWidth, headerWidth(column)))
  })
}

watch(
  () => props.columns,
  () => {
    measureColumns()
    selected.value = null
    editing.value = null
  },
  { immediate: true, deep: false }
)

watch(
  () => props.rows,
  () => {
    if (widths.value.length !== props.columns.length) measureColumns()
  }
)

const gridTemplate = computed(
  () => `56px ${widths.value.map((width) => `${width}px`).join(' ')}`
)

function onScroll(): void {
  if (!viewport.value) return
  scrollTop.value = viewport.value.scrollTop
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!viewport.value) return
  viewportHeight.value = viewport.value.clientHeight
  resizeObserver = new ResizeObserver(() => {
    if (viewport.value) viewportHeight.value = viewport.value.clientHeight
  })
  resizeObserver.observe(viewport.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
})

// --- column resizing -------------------------------------------------------

let resizingColumn = -1
let resizeStartX = 0
let resizeStartWidth = 0

function onResizeStart(index: number, event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
  resizingColumn = index
  resizeStartX = event.clientX
  resizeStartWidth = widths.value[index]
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
  document.body.style.cursor = 'col-resize'
}

function onResizeMove(event: MouseEvent): void {
  if (resizingColumn < 0) return
  const next = [...widths.value]
  next[resizingColumn] = Math.max(MIN_WIDTH, resizeStartWidth + (event.clientX - resizeStartX))
  widths.value = next
}

function onResizeEnd(): void {
  resizingColumn = -1
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
  document.body.style.cursor = ''
}

/** Double-clicking the handle fits the column to its widest visible value. */
function autoFit(index: number): void {
  const column = props.columns[index]
  let longest = 0
  for (const row of props.rows.slice(startIndex.value, endIndex.value)) {
    const text = formatCellForDisplay(row?.[index] ?? null, column.dataType)
    longest = Math.max(longest, (text ?? 'NULL').length)
  }
  const next = [...widths.value]
  next[index] = Math.min(
    MAX_AUTO_WIDTH,
    Math.max(MIN_WIDTH, longest * CELL_CHAR_PX + CELL_PADDING_PX, headerWidth(column))
  )
  widths.value = next
}

// --- selection & editing ---------------------------------------------------

function cellKey(row: number, col: number): string {
  return `${row}:${col}`
}

function displayValue(rowIndex: number, columnIndex: number): string | null {
  const key = cellKey(rowIndex, columnIndex)
  const value =
    key in props.editedCells ? props.editedCells[key] : props.rows[rowIndex]?.[columnIndex]
  return formatCellForDisplay(value ?? null, props.columns[columnIndex]?.dataType)
}

function isEdited(rowIndex: number, columnIndex: number): boolean {
  return cellKey(rowIndex, columnIndex) in props.editedCells
}

function selectCell(row: number, col: number): void {
  selected.value = { row, col }
  emit('selection', { rowIndex: row, columnIndex: col })
}

function sortIndicator(column: ColumnMeta): string {
  const sort = props.sorts.find((entry) => entry.column === column.name)
  if (!sort) return ''
  return sort.direction === 'asc' ? '▲' : '▼'
}

function canEditColumn(columnIndex: number): boolean {
  const column = props.columns[columnIndex]
  return Boolean(props.editable && column && !column.isReadOnly)
}

function beginEdit(row: number, col: number): void {
  if (!canEditColumn(col)) return
  const key = cellKey(row, col)
  const current = key in props.editedCells ? props.editedCells[key] : props.rows[row]?.[col]
  editValue.value = current === null || current === undefined ? '' : formatCellFull(current)
  editing.value = { row, col }
  void nextTick(() => {
    const input = editInput.value
    if (!input) return
    input.focus()
    input.select()
  })
}

/**
 * Commits the open editor and optionally advances, spreadsheet style.
 *
 * The keydown that triggers this also bubbles to the grid's own handler; since
 * the editor has already closed by then, an un-stopped Enter would be read as
 * "start editing this cell" and reopen it immediately. The template stops
 * propagation for exactly that reason.
 */
function commitEdit(move: 'none' | 'down' | 'right' = 'none'): void {
  if (!editing.value) return
  const { row, col } = editing.value
  const column = props.columns[col]
  const original = props.rows[row]?.[col]
  const parsed = parseCellInput(editValue.value, column.jsKind)
  editing.value = null

  // Nothing to record when the text is unchanged.
  if (JSON.stringify(parsed) !== JSON.stringify(original ?? null)) {
    emit('edit', row, col, parsed)
  }

  if (move === 'down' && row < props.rows.length - 1) moveTo(row + 1, col)
  else if (move === 'right' && col < props.columns.length - 1) moveTo(row, col + 1)
  else selectCell(row, col)

  // Return focus to the grid so arrow keys keep working after an edit.
  void nextTick(() => viewport.value?.focus())
}

function cancelEdit(): void {
  editing.value = null
  void nextTick(() => viewport.value?.focus())
}

function setNull(): void {
  if (!selected.value) return
  const { row, col } = selected.value
  if (!canEditColumn(col)) return
  emit('edit', row, col, null)
}

function onCellKeydown(event: KeyboardEvent): void {
  if (editing.value) return
  if (!selected.value) return
  const { row, col } = selected.value
  const lastRow = props.rows.length - 1
  const lastCol = props.columns.length - 1

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      moveTo(Math.min(lastRow, row + 1), col)
      break
    case 'ArrowUp':
      event.preventDefault()
      moveTo(Math.max(0, row - 1), col)
      break
    case 'ArrowLeft':
      event.preventDefault()
      moveTo(row, Math.max(0, col - 1))
      break
    case 'ArrowRight':
    case 'Tab':
      event.preventDefault()
      if (col === lastCol && row < lastRow) moveTo(row + 1, 0)
      else moveTo(row, Math.min(lastCol, col + 1))
      break
    case 'PageDown':
      event.preventDefault()
      moveTo(Math.min(lastRow, row + Math.floor(viewportHeight.value / ROW_HEIGHT)), col)
      break
    case 'PageUp':
      event.preventDefault()
      moveTo(Math.max(0, row - Math.floor(viewportHeight.value / ROW_HEIGHT)), col)
      break
    case 'Home':
      event.preventDefault()
      moveTo(event.ctrlKey ? 0 : row, 0)
      break
    case 'End':
      event.preventDefault()
      moveTo(event.ctrlKey ? lastRow : row, lastCol)
      break
    case 'Enter':
    case 'F2':
      event.preventDefault()
      beginEdit(row, col)
      break
    case 'Delete':
      if (props.editable) {
        event.preventDefault()
        setNull()
      }
      break
    case 'c':
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        void copySelection(event.shiftKey)
      }
      break
    default:
      // Typing a printable character starts an edit with that character.
      if (
        props.editable &&
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        beginEdit(row, col)
        editValue.value = event.key
        event.preventDefault()
      }
  }
}

function moveTo(row: number, col: number): void {
  selectCell(row, col)
  scrollRowIntoView(row)
}

function scrollRowIntoView(row: number): void {
  if (!viewport.value) return
  const top = row * ROW_HEIGHT
  const bottom = top + ROW_HEIGHT
  if (top < viewport.value.scrollTop) viewport.value.scrollTop = top
  else if (bottom > viewport.value.scrollTop + viewportHeight.value) {
    viewport.value.scrollTop = bottom - viewportHeight.value
  }
}

async function copySelection(wholeRow: boolean): Promise<void> {
  if (!selected.value) return
  const { row, col } = selected.value
  const text = wholeRow
    ? props.columns
        .map((_, index) => displayValue(row, index) ?? '')
        .join('\t')
    : (displayValue(row, col) ?? '')
  await api.copyToClipboard(text)
}

function onCellContextMenu(row: number, col: number, event: MouseEvent): void {
  event.preventDefault()
  selectCell(row, col)
  emit('row-context', { rowIndex: row, columnIndex: col, x: event.clientX, y: event.clientY })
}

defineExpose({ selectCell, copySelection, focus: () => viewport.value?.focus() })
</script>

<template>
  <div class="grid">
    <div
      class="grid__header"
      :style="{ gridTemplateColumns: gridTemplate }"
      role="row"
    >
      <div class="grid__corner"></div>
      <div
        v-for="(column, index) in columns"
        :key="`${column.name}-${index}`"
        class="grid__th"
        :title="`${column.name} — ${column.dataType}${column.nullable ? '' : ' NOT NULL'}`"
        @click="emit('sort', column.name, $event.shiftKey)"
      >
        <span class="grid__th-name truncate">{{ column.name }}</span>
        <span v-if="primaryKey.includes(column.name)" class="grid__th-key" title="Primary key">PK</span>
        <span class="grid__th-type truncate">{{ column.dataType }}</span>
        <span v-if="sortIndicator(column)" class="grid__th-sort">{{ sortIndicator(column) }}</span>
        <span
          class="grid__resizer"
          @mousedown="onResizeStart(index, $event)"
          @dblclick.stop="autoFit(index)"
          @click.stop
        ></span>
      </div>
    </div>

    <div
      ref="viewport"
      class="grid__viewport"
      tabindex="0"
      @scroll.passive="onScroll"
      @keydown="onCellKeydown"
    >
      <div v-if="loading" class="grid__overlay">
        <span class="spinner"></span>
        <span>Loading…</span>
      </div>

      <div v-else-if="rows.length === 0" class="empty-state">
        <div class="empty-state__title">{{ emptyMessage }}</div>
      </div>

      <div v-else class="grid__canvas" :style="{ height: `${totalHeight}px` }">
        <div
          v-for="row in visibleRows"
          :key="row.index"
          class="grid__row"
          :class="[
            row.index % 2 === 1 ? 'grid__row--odd' : '',
            row.state === 'inserted' ? 'grid__row--inserted' : '',
            row.state === 'deleted' ? 'grid__row--deleted' : ''
          ]"
          :style="{ transform: `translateY(${row.top}px)`, gridTemplateColumns: gridTemplate }"
        >
          <div class="grid__rownum">{{ rowOffset + row.index + 1 }}</div>
          <div
            v-for="(column, colIndex) in columns"
            :key="colIndex"
            class="grid__cell"
            :class="[
              `grid__cell--${column.jsKind}`,
              selected?.row === row.index && selected?.col === colIndex ? 'grid__cell--selected' : '',
              isEdited(row.index, colIndex) ? 'grid__cell--edited' : '',
              displayValue(row.index, colIndex) === null ? 'grid__cell--null' : ''
            ]"
            @mousedown="selectCell(row.index, colIndex)"
            @dblclick="beginEdit(row.index, colIndex)"
            @contextmenu="onCellContextMenu(row.index, colIndex, $event)"
          >
            <input
              v-if="editing?.row === row.index && editing?.col === colIndex"
              :ref="bindEditInput"
              v-model="editValue"
              class="grid__editor"
              spellcheck="false"
              @keydown.enter.prevent.stop="commitEdit('down')"
              @keydown.esc.prevent.stop="cancelEdit"
              @keydown.tab.prevent.stop="commitEdit('right')"
              @keydown.stop
              @blur="commitEdit()"
            />
            <template v-else>
              <span v-if="displayValue(row.index, colIndex) === null" class="grid__null">NULL</span>
              <span v-else class="truncate">{{ displayValue(row.index, colIndex) }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-surface);
}

.grid__header {
  display: grid;
  height: 30px;
  border-bottom: 1px solid var(--border-strong);
  background: var(--bg-raised);
  overflow: hidden;
  flex: 0 0 auto;
}

.grid__corner {
  border-right: 1px solid var(--border);
  background: var(--bg-raised);
}

.grid__th {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 0 8px;
  border-right: 1px solid var(--border);
  cursor: pointer;
  overflow: hidden;
  line-height: 30px;
  user-select: none;
}
.grid__th:hover {
  background: var(--bg-hover);
}
.grid__th-name {
  font-weight: 600;
  font-size: 12px;
}
.grid__th-key {
  padding: 0 4px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--accent);
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
}
.grid__th-type {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
.grid__th-sort {
  margin-left: auto;
  font-size: 9px;
  color: var(--accent);
}

.grid__resizer {
  position: absolute;
  top: 0;
  right: -3px;
  width: 7px;
  height: 100%;
  cursor: col-resize;
  z-index: 2;
}
.grid__resizer:hover {
  background: var(--border-focus);
  opacity: 0.5;
}

.grid__viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  outline: none;
}

.grid__canvas {
  position: relative;
}

.grid__row {
  position: absolute;
  top: 0;
  left: 0;
  display: grid;
  width: 100%;
  height: 26px;
  will-change: transform;
}
.grid__row--odd {
  background: var(--row-odd);
}
.grid__row--inserted {
  background: var(--cell-inserted);
}
.grid__row--deleted {
  background: var(--cell-deleted);
  text-decoration: line-through;
  opacity: 0.7;
}

.grid__rownum {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 8px;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
}

.grid__cell {
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  cursor: default;
}
.grid__cell--number,
.grid__cell--bytes {
  justify-content: flex-end;
  font-variant-numeric: tabular-nums;
}
.grid__cell--selected {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
  background: var(--bg-selected);
}
.grid__cell--edited {
  background: var(--cell-edited);
}
.grid__null {
  color: var(--text-muted);
  font-style: italic;
  font-size: 11px;
}

.grid__editor {
  width: 100%;
  height: 22px;
  padding: 0 4px;
  border: 1px solid var(--border-focus);
  border-radius: 2px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  outline: none;
  user-select: text;
}

.grid__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-surface) 70%, transparent);
  z-index: 3;
}
</style>
