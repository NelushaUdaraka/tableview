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
    /**
     * Column index -> what its foreign key points at, e.g.
     * `dbo.customers.customer_id`. Those cells get an arrow that asks the
     * parent to open the referenced row.
     */
    foreignKeys?: Record<number, string>
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
    foreignKeys: () => ({}),
    emptyMessage: 'No rows'
  }
)

const emit = defineEmits<{
  (event: 'edit', rowIndex: number, columnIndex: number, value: CellValue): void
  (event: 'sort', column: string, additive: boolean): void
  (event: 'delete-rows', rowIndexes: number[]): void
  (event: 'row-context', payload: { rowIndex: number; columnIndex: number; x: number; y: number }): void
  (event: 'selection', payload: { rowIndex: number; columnIndex: number } | null): void
  (event: 'rows-selected', rowIndexes: number[]): void
  (event: 'follow-key', payload: { rowIndex: number; columnIndex: number }): void
  (event: 'revert-cell', rowIndex: number, columnIndex: number): void
}>()

const ROW_HEIGHT = 30
const OVERSCAN = 8
const MIN_WIDTH = 60
const MAX_AUTO_WIDTH = 420
/** How far the editor may grow over the rows below before it scrolls. */
const MAX_EDITOR_HEIGHT = 220

const viewport = ref<HTMLElement | null>(null)
const header = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(600)
const widths = ref<number[]>([])
const selected = ref<{ row: number; col: number } | null>(null)
/**
 * Rows picked out for an action, which is a different thing from the focused
 * cell: the cell says where typing goes, this says what Delete, Copy and the
 * context menu act on. It always contains the focused row.
 */
const selectedRows = ref<Set<number>>(new Set())
/** Where a Shift range measures from — the last row picked without Shift. */
const anchorRow = ref<number | null>(null)
const editing = ref<{ row: number; col: number } | null>(null)
const editValue = ref('')
const editInput = ref<HTMLTextAreaElement | null>(null)

/**
 * A plain `ref="editInput"` would not work here: Vue collects template refs
 * declared inside a `v-for` into an array, so `editInput.value.focus()` would
 * never run and the cell editor would open unfocused. A function ref binds the
 * single element that `v-if` actually renders.
 */
function bindEditInput(element: Element | ComponentPublicInstance | null): void {
  editInput.value = (element as HTMLTextAreaElement | null) ?? null
}

/**
 * Grows the editor to fit its text.
 *
 * Cells are one line tall, but the values in them are not: an `nvarchar(max)`
 * or a JSON blob is unreadable through a 30px slot. The editor is a textarea
 * that overflows its cell downwards, which is also what makes newlines
 * editable at all.
 */
function autoSizeEditor(): void {
  const input = editInput.value
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${Math.min(MAX_EDITOR_HEIGHT, Math.max(ROW_HEIGHT, input.scrollHeight + 2))}px`
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

const CELL_CHAR_PX = 7.8      // 13px monospace
const HEADER_NAME_PX = 7      // 10px mono caps, tracked 0.1em
const HEADER_TYPE_PX = 6      // 10px monospace type label
const PK_BADGE_PX = 28
const SORT_ARROW_PX = 16
const CELL_PADDING_PX = 28    // 10px each side, plus the 7px gaps between parts

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
    anchorRow.value = null
    // A new shape means the old selection is meaningless; say so, or a row
    // inspector would keep showing a row that is no longer there.
    emit('selection', null)
    setSelectedRows([])
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
  () => `48px ${widths.value.map((width) => `${width}px`).join(' ')}`
)

/** Row-number gutter plus every column, which is how wide a row really is. */
const totalWidth = computed(
  () => 48 + widths.value.reduce((sum, width) => sum + width, 0)
)

function onScroll(): void {
  if (!viewport.value) return
  scrollTop.value = viewport.value.scrollTop
  // The header sits outside the scrolling viewport so it stays put vertically;
  //;horizontally it has to be moved by hand or the columns part company with
  // their values.
  if (header.value) header.value.scrollLeft = viewport.value.scrollLeft
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

function setSelectedRows(rows: Iterable<number>): void {
  selectedRows.value = new Set(rows)
  emit('rows-selected', [...selectedRows.value].sort((a, b) => a - b))
}

/** Every row between two, inclusive, whichever way round they are given. */
function rowRange(from: number, to: number): number[] {
  const [start, end] = from <= to ? [from, to] : [to, from]
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

/**
 * Moves the focus, and takes the row selection with it.
 *
 * `extend` grows the selection from the anchor, `toggle` adds or removes one
 * row, and neither collapses it to the row that was clicked — the three
 * gestures a list has had since long before this grid.
 */
function selectCell(
  row: number,
  col: number,
  modifiers: { extend?: boolean; toggle?: boolean } = {}
): void {
  selected.value = { row, col }
  emit('selection', { rowIndex: row, columnIndex: col })

  if (modifiers.extend && anchorRow.value !== null) {
    setSelectedRows(rowRange(anchorRow.value, row))
    return
  }
  if (modifiers.toggle) {
    const next = new Set(selectedRows.value)
    // Never leave the focused row out of its own selection.
    if (next.has(row) && next.size > 1) next.delete(row)
    else next.add(row)
    anchorRow.value = row
    setSelectedRows(next)
    return
  }
  anchorRow.value = row
  setSelectedRows([row])
}

/** The click handler, so the template does not have to read the event. */
function onCellMouseDown(row: number, col: number, event: MouseEvent): void {
  // A right-click inside the selection keeps it; outside, it collapses to the
  // row under the pointer, which is what every file manager does.
  if (event.button === 2 && selectedRows.value.has(row)) {
    selected.value = { row, col }
    emit('selection', { rowIndex: row, columnIndex: col })
    return
  }
  selectCell(row, col, { extend: event.shiftKey, toggle: event.ctrlKey || event.metaKey })
}

function isRowSelected(row: number): boolean {
  return selectedRows.value.has(row)
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

/**
 * Opens the editor on a cell. `initial` replaces the cell's text — that is the
 * "just start typing" path, where the caret has to land after the character
 * that opened the editor rather than selecting it.
 */
function beginEdit(row: number, col: number, initial?: string): void {
  if (!canEditColumn(col)) return
  const key = cellKey(row, col)
  const current = key in props.editedCells ? props.editedCells[key] : props.rows[row]?.[col]
  editValue.value =
    initial ?? (current === null || current === undefined ? '' : formatCellFull(current))
  editing.value = { row, col }
  void nextTick(() => {
    const input = editInput.value
    if (!input) return
    input.focus()
    if (initial === undefined) input.select()
    else input.setSelectionRange(input.value.length, input.value.length)
    autoSizeEditor()
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
      moveTo(Math.min(lastRow, row + 1), col, event.shiftKey)
      break
    case 'ArrowUp':
      event.preventDefault()
      moveTo(Math.max(0, row - 1), col, event.shiftKey)
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
      if (!props.editable) break
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        emit('delete-rows', [...selectedRows.value].sort((a, b) => a - b))
      } else {
        setNull()
      }
      break
    case 'c':
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        void copySelection(event.shiftKey)
      }
      break
    case 'a':
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        anchorRow.value = 0
        setSelectedRows(rowRange(0, lastRow))
      }
      break
    case 'Backspace':
      // Delete on its own nulls a cell, so deleting rows takes the modifier.
      if ((event.ctrlKey || event.metaKey) && props.editable) {
        event.preventDefault()
        emit('delete-rows', [...selectedRows.value].sort((a, b) => a - b))
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
        beginEdit(row, col, event.key)
        event.preventDefault()
      }
  }
}

function moveTo(row: number, col: number, extend = false): void {
  selectCell(row, col, { extend })
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

/** One row as the grid shows it, tab separated. */
function rowAsText(row: number): string {
  return props.columns.map((_, index) => displayValue(row, index) ?? '').join('\t')
}

async function copySelection(wholeRow: boolean): Promise<void> {
  if (!selected.value) return
  const { row, col } = selected.value

  // Several rows picked out is an explicit request for all of them, whether
  // or not the caller asked for the whole row.
  const rows = [...selectedRows.value].sort((a, b) => a - b)
  const text =
    rows.length > 1
      ? rows.map(rowAsText).join('\n')
      : wholeRow
        ? rowAsText(row)
        : (displayValue(row, col) ?? '')
  await api.copyToClipboard(text)
}

/** An arrow is only offered where there is a row to open. */
function canFollowKey(row: number, col: number): boolean {
  return Boolean(props.foreignKeys[col]) && displayValue(row, col) !== null
}

function followKey(row: number, col: number): void {
  if (!canFollowKey(row, col)) return
  selectCell(row, col)
  emit('follow-key', { rowIndex: row, columnIndex: col })
}

function onCellContextMenu(row: number, col: number, event: MouseEvent): void {
  event.preventDefault()
  // mousedown has already settled the selection; only a keyboard-driven menu
  // arrives here without one.
  if (!selectedRows.value.has(row)) selectCell(row, col)
  emit('row-context', { rowIndex: row, columnIndex: col, x: event.clientX, y: event.clientY })
}

defineExpose({
  selectCell: (row: number, col: number) => selectCell(row, col),
  beginEdit,
  copySelection,
  selectRows: (rows: number[]) => {
    anchorRow.value = rows[0] ?? null
    setSelectedRows(rows)
  },
  focus: () => viewport.value?.focus()
})
</script>

<template>
  <div class="grid">
    <div ref="header" class="grid__header" role="row">
      <div class="grid__header-track" :style="{ gridTemplateColumns: gridTemplate }">
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

      <div
        v-else
        class="grid__canvas"
        :style="{ height: `${totalHeight}px`, width: `${totalWidth}px` }"
      >
        <div
          v-for="row in visibleRows"
          :key="row.index"
          class="grid__row"
          :class="[
            row.index % 2 === 1 ? 'grid__row--odd' : '',
            row.state === 'inserted' ? 'grid__row--inserted' : '',
            row.state === 'deleted' ? 'grid__row--deleted' : '',
            editing?.row === row.index ? 'grid__row--editing' : '',
            isRowSelected(row.index) ? 'grid__row--selected' : ''
          ]"
          :style="{ transform: `translateY(${row.top}px)`, gridTemplateColumns: gridTemplate }"
        >
          <div
            class="grid__rownum"
            @mousedown="onCellMouseDown(row.index, 0, $event)"
            @contextmenu="onCellContextMenu(row.index, 0, $event)"
          >
            {{ rowOffset + row.index + 1 }}
          </div>
          <div
            v-for="(column, colIndex) in columns"
            :key="colIndex"
            class="grid__cell"
            :class="[
              `grid__cell--${column.jsKind}`,
              selected?.row === row.index && selected?.col === colIndex ? 'grid__cell--selected' : '',
              isEdited(row.index, colIndex) ? 'grid__cell--edited' : '',
              displayValue(row.index, colIndex) === null ? 'grid__cell--null' : '',
              editing?.row === row.index && editing?.col === colIndex ? 'grid__cell--editing' : ''
            ]"
            @mousedown="onCellMouseDown(row.index, colIndex, $event)"
            @dblclick="beginEdit(row.index, colIndex)"
            @contextmenu="onCellContextMenu(row.index, colIndex, $event)"
          >
            <textarea
              v-if="editing?.row === row.index && editing?.col === colIndex"
              :ref="bindEditInput"
              v-model="editValue"
              class="grid__editor"
              rows="1"
              spellcheck="false"
              @input="autoSizeEditor"
              @keydown.enter.exact.prevent.stop="commitEdit('down')"
              @keydown.esc.prevent.stop="cancelEdit"
              @keydown.tab.prevent.stop="commitEdit('right')"
              @keydown.stop
              @blur="commitEdit()"
            ></textarea>
            <template v-else>
              <span v-if="displayValue(row.index, colIndex) === null" class="grid__null">NULL</span>
              <span v-else class="truncate">{{ displayValue(row.index, colIndex) }}</span>
              <button
                v-if="isEdited(row.index, colIndex)"
                class="grid__revert"
                title="Undo this edit"
                @mousedown.stop
                @click.stop="emit('revert-cell', row.index, colIndex)"
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M4.6 2.6 2 5.2l2.6 2.6M2.4 5.2h4.3a2.9 2.9 0 0 1 0 5.8H4.1"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <button
                v-if="canFollowKey(row.index, colIndex)"
                class="grid__fk"
                :title="`Open ${foreignKeys[colIndex]} = ${displayValue(row.index, colIndex)}`"
                @mousedown.stop
                @click.stop="followKey(row.index, colIndex)"
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M4 2.4 7.8 6 4 9.6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
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
  height: var(--h-gridheader);
  border-bottom: var(--rule) solid var(--border-strong);
  background: var(--bg-app);
  /* Scrolled in step with the viewport rather than by the user, so the bar
     itself never shows one. */
  overflow: hidden;
  flex: 0 0 auto;
}
.grid__header-track {
  display: grid;
  height: 100%;
  /* Never narrower than the bar, so a table that fits still fills it. */
  min-width: 100%;
  width: max-content;
}

.grid__corner {
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-app);
}

.grid__th {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border-right: 1px solid var(--border-subtle);
  cursor: pointer;
  overflow: hidden;
  user-select: none;
}
.grid__th:hover {
  background: var(--bg-hover);
}
.grid__th-name {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
/* The key badge is solid accent — it marks identity in a field of grey. */
.grid__th-key {
  flex: 0 0 auto;
  padding: 1px 5px;
  border-radius: 0;
  background: var(--accent);
  color: var(--accent-text);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
.grid__th-type {
  font-size: 10px;
  color: var(--text-dim);
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
  background: var(--accent);
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
  /* Rows are absolutely positioned inside this, so its width is what decides
     how far the viewport scrolls and how far a row's background reaches. */
  min-width: 100%;
}

.grid__row {
  position: absolute;
  top: 0;
  left: 0;
  display: grid;
  width: 100%;
  height: var(--row-height);
  will-change: transform;
}
.grid__row--odd {
  background: var(--row-odd);
}
/* Staged rows are marked on their leading edge rather than washed in colour. */
.grid__row--inserted {
  background: var(--bg-inserted);
}
.grid__row--inserted .grid__rownum,
.grid__row--deleted .grid__rownum {
  box-shadow: var(--row-staged);
}
.grid__row--deleted {
  text-decoration: line-through;
  opacity: 0.45;
}
/* The open editor overflows its cell, so its row has to paint over the rest. */
.grid__row--editing {
  z-index: 5;
}
/* Picked-out rows carry the accent wash the rest of the app selects with, and
   a solid leading edge so a run of them reads as one block. */
.grid__row--selected {
  background: var(--selection-idle);
}
.grid__row--selected .grid__rownum {
  box-shadow: inset 2px 0 0 var(--accent);
  color: var(--text-primary);
}

.grid__rownum {
  cursor: default;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 10px;
  border-right: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
}

.grid__cell {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: default;
}
.grid__cell--number,
.grid__cell--bytes {
  justify-content: flex-end;
  font-variant-numeric: tabular-nums;
}
.grid__cell--selected {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: var(--bg-selected);
}
/* An edited cell is underscored in accent, not filled — the value stays legible. */
.grid__cell--edited {
  box-shadow: var(--cell-edited);
}
.grid__cell--editing {
  overflow: visible;
  z-index: 2;
}
.grid__cell > .truncate {
  min-width: 0;
}

/* --- foreign key arrow --------------------------------------------------- */
/* The undo affordance on a staged cell: always visible, because it is the
   only sign that this value is not the one in the database yet. */
.grid__revert {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-left: auto;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--warning);
  cursor: pointer;
}
.grid__revert svg {
  width: 11px;
  height: 11px;
}
.grid__revert:hover {
  background: var(--accent);
  color: var(--accent-text);
}
/* A right-aligned value keeps its edge; the control sits after it. */
.grid__cell--number .grid__revert,
.grid__cell--bytes .grid__revert {
  margin-left: 6px;
}
/* With both, the foreign-key arrow gives up the auto margin. */
.grid__revert + .grid__fk {
  margin-left: 6px;
}

.grid__fk {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-left: auto;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--accent);
  opacity: 0.65;
  cursor: pointer;
}
/* Right-aligned values keep their edge; the arrow follows the number. */
.grid__cell--number .grid__fk,
.grid__cell--bytes .grid__fk {
  margin-left: 0;
}
.grid__fk svg {
  width: 11px;
  height: 11px;
}
.grid__cell:hover .grid__fk,
.grid__cell--selected .grid__fk {
  opacity: 1;
}
.grid__fk:hover {
  background: var(--accent);
  color: var(--accent-text);
  opacity: 1;
}
.grid__null {
  color: var(--text-dim);
  font-style: italic;
  font-size: 13px;
}

.grid__editor {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 6;
  width: 100%;
  /* Narrow columns still need room to read what is being typed. */
  min-width: 240px;
  max-width: 520px;
  min-height: var(--row-height);
  padding: 6px 9px;
  border: 1px solid var(--accent);
  border-radius: 0;
  background: var(--bg-input);
  box-shadow: var(--shadow-menu);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 17px;
  white-space: pre-wrap;
  overflow-y: auto;
  resize: none;
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
