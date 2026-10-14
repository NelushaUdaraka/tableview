<script setup lang="ts">
/**
 * The selected row, one field per line.
 *
 * A grid row is a 26px slot per value, which is the wrong shape for anything
 * long — a description, a JSON document, a row with forty columns. This panel
 * shows the same row down the side of the window where every value has room,
 * and edits made here are the *same* staged edits the grid makes: the parent
 * owns them, this only reports them.
 *
 * A field holding a JSON document gets more than room: it is shown as a tree,
 * since what anyone wants of a document is its shape and one of its values,
 * neither of which survives being printed as one long line. The text is still
 * what is stored and still what is edited — *raw* switches to it.
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { CellValue, ColumnMeta } from '@shared/types'
import { formatCellFull, parseCellInput } from '@shared/serialize'
import JsonTree from './JsonTree.vue'
import { parseJsonCell, previewOf } from '../lib/jsonCell'

export interface RowField {
  column: ColumnMeta
  /** The value as it stands, staged edits included. */
  value: CellValue
  edited: boolean
  isPrimaryKey: boolean
  /** `dbo.customers.customer_id` when this column is a foreign key. */
  foreignKey?: string
}

const props = withDefaults(
  defineProps<{
    fields: RowField[]
    /** `12 of 200`, or empty when nothing is selected. The word "Row" is the
     * panel's own kicker, so the label carries only the position. */
    label?: string
    editable?: boolean
    state?: 'normal' | 'inserted' | 'deleted'
    /** Column selected in the grid, highlighted and scrolled to here. */
    selectedIndex?: number | null
    hasPrevious?: boolean
    hasNext?: boolean
  }>(),
  {
    label: '',
    editable: false,
    state: 'normal',
    selectedIndex: null,
    hasPrevious: false,
    hasNext: false
  }
)

const emit = defineEmits<{
  (event: 'edit', columnIndex: number, value: CellValue): void
  (event: 'revert', columnIndex: number): void
  (event: 'follow-key', columnIndex: number): void
  (event: 'select', columnIndex: number): void
  (event: 'move', delta: number): void
  (event: 'close'): void
}>()

const list = ref<HTMLElement | null>(null)

/** Keeps the field the grid is on in view as the selection moves. */
watch(
  () => props.selectedIndex,
  (index) => {
    if (index === null || index === undefined) return
    void nextTick(() => {
      list.value
        ?.querySelector<HTMLElement>(`[data-field="${index}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    })
  }
)

function text(field: RowField): string {
  return field.value === null ? '' : formatCellFull(field.value)
}

/**
 * The JSON each field is holding, or `null` where it is holding none.
 *
 * Parsed once per row rather than per render: `fields` is rebuilt whenever the
 * row or a staged edit changes, which is exactly when an answer here could
 * have changed too.
 */
const documents = computed(() => props.fields.map((field) => parseJsonCell(text(field))))

/** Fields the reader has switched to raw text, by column name. */
const asRaw = ref<Record<string, boolean>>({})

function showsJson(index: number): boolean {
  const field = props.fields[index]
  return Boolean(field) && documents.value[index] !== null && !asRaw.value[field.column.name]
}

function toggleRaw(index: number): void {
  const field = props.fields[index]
  if (!field) return
  asRaw.value = { ...asRaw.value, [field.column.name]: !asRaw.value[field.column.name] }
  // A field switched back to text has to be sized to it, the way the rest were.
  void nextTick(sizeAll)
}

function canEdit(field: RowField): boolean {
  return props.editable && !field.column.isReadOnly
}

/**
 * Commits on change rather than on every keystroke: `change` fires when the
 * field is left or Enter ends the edit, which is when the user has finished
 * saying what they mean. Unchanged text stages nothing.
 */
function commit(index: number, value: string): void {
  const field = props.fields[index]
  if (!field || !canEdit(field)) return
  const parsed = parseCellInput(value, field.column.jsKind)
  if (JSON.stringify(parsed) === JSON.stringify(field.value ?? null)) return
  emit('edit', index, parsed)
}

function setNull(index: number): void {
  const field = props.fields[index]
  if (!field || !canEdit(field) || field.value === null) return
  emit('edit', index, null)
}

/**
 * Whether a field holds text typed into it that has not been committed.
 *
 * A field commits when it is left, so until then the typing lives only in
 * the textarea — where new rows arriving under it would replace it, or leave
 * it showing against a different row.
 */
function hasUncommittedEdit(): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLTextAreaElement) || !list.value?.contains(active)) return false
  const index = Number(active.closest('[data-field]')?.getAttribute('data-field'))
  const field = props.fields[index]
  return field !== undefined && active.value !== text(field)
}

defineExpose({ hasUncommittedEdit })

/**
 * How tall one field may grow before it scrolls inside itself.
 *
 * The panel is a column of fields, so an unbounded one would push every other
 * field out of view; this is the point where showing more of one value costs
 * more than it gives.
 */
const MAX_FIELD_HEIGHT = 420
const MIN_FIELD_HEIGHT = 26

function size(input: HTMLTextAreaElement): void {
  input.style.height = 'auto'
  input.style.height = `${Math.min(MAX_FIELD_HEIGHT, Math.max(MIN_FIELD_HEIGHT, input.scrollHeight + 2))}px`
}

function autoSize(event: Event): void {
  size(event.target as HTMLTextAreaElement)
}

/**
 * Sizes every editable field to its content.
 *
 * The textareas are uncontrolled and start at one row, so without this a long
 * value — the whole reason this panel exists — would sit in a 26px slot until
 * the user typed into it. Runs whenever the row or its values change.
 */
function sizeAll(): void {
  const inputs = list.value?.querySelectorAll<HTMLTextAreaElement>('textarea.rowpanel__value')
  for (const input of inputs ?? []) size(input)
}

// `fields` is rebuilt whenever the row or a staged edit changes, so its
// identity is signal enough — a deep traversal would only cost more.
watch(() => props.fields, () => void nextTick(sizeAll), { immediate: true })
</script>

<template>
  <aside class="rowpanel">
    <header class="rowpanel__head">
      <span class="kicker rowpanel__kicker">Row</span>
      <span class="rowpanel__title mono truncate">
        <template v-if="label">{{ label }}</template>
        <span v-else class="dim">none selected</span>
      </span>
      <span v-if="state === 'inserted'" class="badge badge--accent">new</span>
      <span v-if="state === 'deleted'" class="badge">deleted</span>
      <div class="rowpanel__spacer"></div>
      <button
        class="rowpanel__btn"
        title="Previous row"
        :disabled="!hasPrevious"
        @click="emit('move', -1)"
      >
        ‹
      </button>
      <button class="rowpanel__btn" title="Next row" :disabled="!hasNext" @click="emit('move', 1)">
        ›
      </button>
      <button class="rowpanel__btn" title="Hide the row panel (Ctrl+I)" @click="emit('close')">
        ✕
      </button>
    </header>

    <div v-if="fields.length === 0" class="rowpanel__empty">
      <p>Select a cell to see its whole row here.</p>
    </div>

    <div v-else ref="list" class="rowpanel__fields">
      <div
        v-for="(field, index) in fields"
        :key="field.column.name"
        class="rowpanel__field"
        :class="{
          'rowpanel__field--selected': selectedIndex === index,
          'rowpanel__field--edited': field.edited
        }"
        :data-field="index"
      >
        <div class="rowpanel__label">
          <span class="rowpanel__name truncate">{{ field.column.name }}</span>
          <span v-if="field.isPrimaryKey" class="badge badge--pk">PK</span>
          <button
            v-if="field.foreignKey"
            class="rowpanel__fk"
            :title="`Open ${field.foreignKey} = ${text(field)}`"
            :disabled="field.value === null"
            @click="emit('follow-key', index)"
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
          <span class="rowpanel__type mono truncate">{{ field.column.dataType }}</span>
          <button
            v-if="documents[index]"
            class="rowpanel__mode"
            :title="showsJson(index) ? 'Show the stored text' : 'Show it as JSON'"
            @click="toggleRaw(index)"
          >
            {{ showsJson(index) ? 'raw' : previewOf(documents[index]!) }}
          </button>
          <button
            v-if="field.edited"
            class="rowpanel__revert"
            title="Undo this edit"
            @click="emit('revert', index)"
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
            v-if="canEdit(field)"
            class="rowpanel__null"
            :disabled="field.value === null"
            title="Set this field to NULL"
            @click="setNull(index)"
          >
            NULL
          </button>
        </div>

        <!-- Editing is editing the text, so the tree stands aside for it: a
             field being read shows the document, `raw` shows what is stored. -->
        <div
          v-if="showsJson(index)"
          class="rowpanel__value rowpanel__value--json"
          @click="emit('select', index)"
        >
          <JsonTree :value="documents[index]!" />
        </div>
        <textarea
          v-else-if="canEdit(field)"
          class="rowpanel__value"
          :value="text(field)"
          :placeholder="field.value === null ? 'NULL' : ''"
          rows="1"
          spellcheck="false"
          @focus="emit('select', index)"
          @input="autoSize"
          @change="commit(index, ($event.target as HTMLTextAreaElement).value)"
          @keydown.enter.exact.prevent="($event.target as HTMLTextAreaElement).blur()"
        ></textarea>
        <div v-else class="rowpanel__value rowpanel__value--readonly" @click="emit('select', index)">
          <span v-if="field.value === null" class="rowpanel__nullmark">NULL</span>
          <template v-else>{{ text(field) }}</template>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.rowpanel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border-left: var(--rule) solid var(--border-strong);
  background: var(--bg-surface);
}

.rowpanel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--h-gridheader);
  padding: 0 4px 0 14px;
  border-bottom: var(--rule) solid var(--border-strong);
  background: var(--bg-app);
  flex: 0 0 auto;
}
.rowpanel__kicker {
  flex: 0 0 auto;
  font-weight: 700;
  letter-spacing: 0.14em;
}
.rowpanel__title {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.rowpanel__spacer {
  flex: 1;
}
.rowpanel__btn {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.rowpanel__btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.rowpanel__btn:last-child:hover:not(:disabled) {
  background: var(--accent);
  color: var(--accent-text);
}
.rowpanel__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.rowpanel__empty {
  padding: 16px;
  color: var(--text-muted);
  font-size: 13px;
}

.rowpanel__fields {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* Each field is a ruled band; state is marked on the leading edge. */
.rowpanel__field {
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
}
.rowpanel__field--selected {
  background: var(--bg-raised);
  box-shadow: var(--row-staged);
}
.rowpanel__field--edited {
  box-shadow: var(--row-staged);
}

.rowpanel__label {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
  min-width: 0;
}
.rowpanel__name {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-primary);
}
.rowpanel__type {
  flex: 1;
  font-size: 10px;
  color: var(--text-dim);
  text-align: right;
}
.rowpanel__fk {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
}
.rowpanel__fk svg {
  width: 11px;
  height: 11px;
}
.rowpanel__fk:hover:not(:disabled) {
  background: var(--accent);
  color: var(--accent-text);
}
.rowpanel__fk:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
/* Matches the grid's undo: same mark, same colour, on the same staged edit. */
.rowpanel__revert {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--warning);
  cursor: pointer;
}
.rowpanel__revert svg {
  width: 11px;
  height: 11px;
}
.rowpanel__revert:hover {
  background: var(--accent);
  color: var(--accent-text);
}

.rowpanel__null {
  flex: 0 0 auto;
  padding: 1px 5px;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  cursor: pointer;
}
.rowpanel__null:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--text-muted);
}
.rowpanel__null:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.rowpanel__value {
  display: block;
  width: 100%;
  min-height: var(--row-height);
  /* Matches MAX_FIELD_HEIGHT, which sizes the editable fields in script. */
  max-height: 420px;
  padding: 6px 9px;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 17px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  resize: none;
  outline: none;
  user-select: text;
}
.rowpanel__value:focus {
  border-color: var(--accent);
}
.rowpanel__value--readonly {
  color: var(--text-secondary);
}
/* The tree brings its own rows; the box only has to hold them and scroll. */
.rowpanel__value--json {
  padding: 5px 7px;
  cursor: default;
}

/* Says what the field is holding, and switches to the other way of reading it:
   `{4}` over the text, `raw` over the tree. */
.rowpanel__mode {
  flex: 0 0 auto;
  padding: 1px 5px;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  cursor: pointer;
}
.rowpanel__mode:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
}
.rowpanel__nullmark {
  color: var(--text-dim);
  font-style: italic;
}
</style>
