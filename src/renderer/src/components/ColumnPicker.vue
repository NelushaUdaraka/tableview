<script setup lang="ts">
/**
 * Which of a table's columns the grid draws, ticked off in a list.
 *
 * The page is read whole whatever is ticked (see lib/columnVisibility.ts), so a
 * tick takes effect at once and nothing is run. The search narrows a wide
 * table's list, and the two buttons at the foot act on what is listed: type
 * "date", *Hide matching*, and every column with that in its name goes.
 */
import { computed, ref } from 'vue'
import type { ColumnMeta } from '@shared/types'
import {
  hideColumns,
  matchColumns,
  setColumnShown,
  showColumns
} from '../lib/columnVisibility'
import AppIcon from './AppIcon.vue'
import PopoverPanel from './PopoverPanel.vue'

const props = defineProps<{
  anchor: HTMLElement | null
  columns: ColumnMeta[]
  /** Names of the columns taken out of the grid. */
  hidden: string[]
  primaryKey: string[]
}>()

const emit = defineEmits<{
  (event: 'update:hidden', names: string[]): void
  (event: 'close'): void
}>()

const query = ref('')
const searching = computed(() => query.value.trim() !== '')
const hiddenNames = computed(() => new Set(props.hidden))
const listed = computed(() => matchColumns(props.columns, query.value))
const listedNames = computed(() => listed.value.map((column) => column.name))

const shownCount = computed(
  () => props.columns.filter((column) => !hiddenNames.value.has(column.name)).length
)
const anyListedHidden = computed(() => listedNames.value.some((name) => hiddenNames.value.has(name)))
const anyListedShown = computed(() => listedNames.value.some((name) => !hiddenNames.value.has(name)))

function toggle(name: string, shown: boolean): void {
  emit('update:hidden', setColumnShown(props.hidden, name, shown))
}

function showListed(): void {
  // Everything back means the list starts again from nothing, names of
  // columns long gone included.
  emit('update:hidden', searching.value ? showColumns(props.hidden, listedNames.value) : [])
}

function hideListed(): void {
  emit('update:hidden', hideColumns(props.hidden, listedNames.value))
}

/** Escape clears a search before it closes the panel. */
function onSearchKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !query.value) return
  event.preventDefault()
  event.stopPropagation()
  query.value = ''
}
</script>

<template>
  <PopoverPanel :anchor="anchor" role="dialog" label="Columns to show" @close="emit('close')">
    <div class="picker">
      <label class="picker__search">
        <AppIcon name="search" :size="14" />
        <input
          v-model="query"
          class="picker__input"
          placeholder="Find a column"
          aria-label="Find a column"
          spellcheck="false"
          data-popover-item
          data-popover-autofocus
          @keydown="onSearchKeyDown"
        />
      </label>

      <div class="picker__list" role="group" aria-label="Columns">
        <label
          v-for="column in listed"
          :key="column.name"
          class="checkbox picker__row"
          :title="`${column.name} — ${column.dataType}`"
        >
          <input
            type="checkbox"
            :checked="!hiddenNames.has(column.name)"
            data-popover-item
            @change="toggle(column.name, ($event.target as HTMLInputElement).checked)"
          />
          <span class="picker__name truncate">{{ column.name }}</span>
          <span v-if="primaryKey.includes(column.name)" class="badge badge--pk">PK</span>
          <span class="picker__type truncate">{{ column.dataType }}</span>
        </label>
        <p v-if="listed.length === 0" class="picker__none">
          No column matches “{{ query.trim() }}”
        </p>
      </div>

      <div class="picker__foot">
        <span class="picker__count">{{ shownCount }} of {{ columns.length }} shown</span>
        <button class="btn btn--sm btn--ghost" :disabled="!anyListedHidden" @click="showListed">
          {{ searching ? 'Show matching' : 'Show all' }}
        </button>
        <button class="btn btn--sm btn--ghost" :disabled="!anyListedShown" @click="hideListed">
          {{ searching ? 'Hide matching' : 'Hide all' }}
        </button>
      </div>
    </div>
  </PopoverPanel>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  width: 300px;
  min-height: 0;
}
/* A field without a box: the panel is the box. */
.picker__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  margin: 0 0 4px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-muted);
  transition: border-color var(--transition);
}
.picker__search:focus-within {
  border-bottom-color: var(--accent);
}
.picker__input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  user-select: text;
}
.picker__input::placeholder {
  color: var(--text-muted);
}
.picker__list {
  display: flex;
  flex-direction: column;
  max-height: 320px;
  overflow-y: auto;
}
.picker__row {
  gap: 8px;
  height: 28px;
  flex: 0 0 auto;
  padding: 0 8px;
  border-radius: 5px;
}
.picker__row:hover {
  background: var(--bg-hover-strong);
}
/* Column names are identifiers: the mono, at full strength, in their own
   case; the type quieter beside them, as the grid's header sets it. */
.picker__name {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
}
.picker__type {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  padding-left: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}
.picker__none {
  margin: 0;
  padding: 10px 8px;
  font-size: 12px;
  color: var(--text-muted);
}
.picker__foot {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 4px;
  padding: 6px 0 2px 8px;
  border-top: 1px solid var(--border-subtle);
}
.picker__count {
  flex: 1;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
