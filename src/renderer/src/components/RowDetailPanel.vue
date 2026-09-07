<script setup lang="ts">
/**
 * The selected row, one field per line.
 *
 * A grid row is a 26px slot per value, which is the wrong shape for anything
 * long — a description, a JSON document, a row with forty columns. This panel
 * shows the same row down the side of the window where every value has room,
 * and edits made here are the *same* staged edits the grid makes: the parent
 * owns them, this only reports them.
 */
import { nextTick, ref, watch } from 'vue'
import type { CellValue, ColumnMeta } from '@shared/types'
import { formatCellFull, parseCellInput } from '@shared/serialize'

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
    /** `Row 12 of 200`, or empty when nothing is selected. */
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

function autoSize(event: Event): void {
  const input = event.target as HTMLTextAreaElement
  input.style.height = 'auto'
  input.style.height = `${Math.min(260, Math.max(26, input.scrollHeight + 2))}px`
}
</script>

<template>
  <aside class="rowpanel">
    <header class="rowpanel__head">
      <span class="rowpanel__title truncate">{{ label || 'No row selected' }}</span>
      <span v-if="state === 'inserted'" class="badge">new</span>
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
            v-if="canEdit(field)"
            class="rowpanel__null"
            :disabled="field.value === null"
            title="Set this field to NULL"
            @click="setNull(index)"
          >
            NULL
          </button>
        </div>

        <textarea
          v-if="canEdit(field)"
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
  border-left: 1px solid var(--border);
  background: var(--bg-surface);
}

.rowpanel__head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 4px 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
  flex: 0 0 auto;
}
.rowpanel__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}
.rowpanel__spacer {
  flex: 1;
}
.rowpanel__btn {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.rowpanel__btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.rowpanel__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.rowpanel__empty {
  padding: 16px;
  color: var(--text-muted);
  font-size: 12px;
}

.rowpanel__fields {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0;
}

.rowpanel__field {
  padding: 5px 10px;
  border-left: 2px solid transparent;
}
.rowpanel__field--selected {
  background: var(--bg-hover);
  border-left-color: var(--border-focus);
}
.rowpanel__field--edited {
  border-left-color: var(--success);
}

.rowpanel__label {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 3px;
  min-width: 0;
}
.rowpanel__name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}
.rowpanel__type {
  flex: 1;
  font-size: 10px;
  color: var(--text-muted);
}
.rowpanel__fk {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--info);
  cursor: pointer;
}
.rowpanel__fk svg {
  width: 11px;
  height: 11px;
}
.rowpanel__fk:hover:not(:disabled) {
  background: color-mix(in srgb, var(--info) 22%, transparent);
}
.rowpanel__fk:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.rowpanel__null {
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text-muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
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
  min-height: 26px;
  max-height: 260px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 16px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  resize: none;
  outline: none;
  user-select: text;
}
.rowpanel__value:focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--border-focus) 22%, transparent);
}
.rowpanel__value--readonly {
  background: transparent;
  color: var(--text-secondary);
  cursor: default;
}
.rowpanel__nullmark {
  color: var(--text-muted);
  font-style: italic;
  font-size: 11px;
}
</style>
