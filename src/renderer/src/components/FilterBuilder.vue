<script setup lang="ts">
import { computed } from 'vue'
import type { FilterOperator, TableColumn, TableFilter } from '@shared/types'

const props = defineProps<{
  columns: TableColumn[]
  filters: TableFilter[]
  mode: 'builder' | 'raw'
  rawWhere: string
}>()

const emit = defineEmits<{
  (event: 'update:filters', value: TableFilter[]): void
  (event: 'update:mode', value: 'builder' | 'raw'): void
  (event: 'update:rawWhere', value: string): void
  (event: 'apply'): void
}>()

const OPERATORS: FilterOperator[] = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'contains',
  'starts with',
  'ends with',
  'like',
  'not like',
  'in',
  'not in',
  'between',
  'is null',
  'is not null'
]

const NO_VALUE: FilterOperator[] = ['is null', 'is not null']

function needsValue(operator: FilterOperator): boolean {
  return !NO_VALUE.includes(operator)
}

function needsSecondValue(operator: FilterOperator): boolean {
  return operator === 'between'
}

function add(): void {
  const first = props.columns[0]?.name ?? ''
  emit('update:filters', [
    ...props.filters,
    { column: first, operator: '=', value: '', conjunction: 'AND' }
  ])
}

function remove(index: number): void {
  emit(
    'update:filters',
    props.filters.filter((_, i) => i !== index)
  )
}

function patch(index: number, changes: Partial<TableFilter>): void {
  emit(
    'update:filters',
    props.filters.map((filter, i) => (i === index ? { ...filter, ...changes } : filter))
  )
}

const canApply = computed(() =>
  props.mode === 'raw'
    ? true
    : props.filters.every((filter) => filter.column && (!needsValue(filter.operator) || true))
)

function placeholderFor(operator: FilterOperator): string {
  if (operator === 'in' || operator === 'not in') return "'a', 'b', 'c'"
  if (operator === 'like' || operator === 'not like') return '%pattern%'
  return 'value'
}
</script>

<template>
  <div class="filters">
    <div class="filters__head">
      <div class="seg seg--caps">
        <button
          class="seg__opt filters__mode"
          :class="{ 'seg__opt--on': mode === 'builder' }"
          @click="emit('update:mode', 'builder')"
        >
          Filters
        </button>
        <button
          class="seg__opt filters__mode"
          :class="{ 'seg__opt--on': mode === 'raw' }"
          @click="emit('update:mode', 'raw')"
        >
          Raw WHERE
        </button>
      </div>
      <div class="filters__spacer"></div>
      <button v-if="mode === 'builder'" class="btn btn--sm" @click="add">+ Add filter</button>
      <button class="btn btn--sm btn--primary" :disabled="!canApply" @click="emit('apply')">
        Apply
      </button>
    </div>

    <div v-if="mode === 'raw'" class="filters__raw">
      <input
        :value="rawWhere"
        class="input mono"
        placeholder="credit_limit > 100 AND is_active = 1"
        spellcheck="false"
        @input="emit('update:rawWhere', ($event.target as HTMLInputElement).value)"
        @keydown.enter="emit('apply')"
      />
      <p class="filters__hint">
        Written straight into the WHERE clause — the leading <code>WHERE</code> is optional.
      </p>
    </div>

    <div v-else-if="filters.length" class="filters__list">
      <div v-for="(filter, index) in filters" :key="index" class="filters__row">
        <select
          v-if="index > 0"
          class="select filters__conj"
          :value="filter.conjunction ?? 'AND'"
          @change="patch(index, { conjunction: ($event.target as HTMLSelectElement).value as 'AND' | 'OR' })"
        >
          <option value="AND">AND</option>
          <option value="OR">OR</option>
        </select>
        <span v-else class="filters__conj filters__conj--fixed caps">Where</span>

        <select
          class="select filters__column"
          :value="filter.column"
          @change="patch(index, { column: ($event.target as HTMLSelectElement).value })"
        >
          <option v-for="column in columns" :key="column.name" :value="column.name">
            {{ column.name }}
          </option>
        </select>

        <select
          class="select filters__op"
          :value="filter.operator"
          @change="patch(index, { operator: ($event.target as HTMLSelectElement).value as FilterOperator })"
        >
          <option v-for="operator in OPERATORS" :key="operator" :value="operator">
            {{ operator }}
          </option>
        </select>

        <input
          v-if="needsValue(filter.operator)"
          class="input filters__value"
          :value="filter.value"
          :placeholder="placeholderFor(filter.operator)"
          spellcheck="false"
          @input="patch(index, { value: ($event.target as HTMLInputElement).value })"
          @keydown.enter="emit('apply')"
        />
        <input
          v-if="needsSecondValue(filter.operator)"
          class="input filters__value"
          :value="filter.value2"
          placeholder="and"
          spellcheck="false"
          @input="patch(index, { value2: ($event.target as HTMLInputElement).value })"
          @keydown.enter="emit('apply')"
        />

        <button class="filters__remove" title="Remove" @click="remove(index)">✕</button>
      </div>
    </div>

    <p v-else class="filters__empty muted">No filters — every row is shown.</p>
  </div>
</template>

<style scoped>
.filters {
  padding: 12px;
  border-bottom: var(--rule) solid var(--border-strong);
  background: var(--bg-app);
}
.filters__head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.filters__mode {
  height: var(--h-control-sm);
}
.filters__spacer {
  flex: 1;
}
.filters__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.filters__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.filters__conj {
  width: 76px;
  flex: 0 0 76px;
  height: 30px;
  font-size: 11px;
  font-weight: 700;
}
.filters__conj--fixed {
  display: flex;
  align-items: center;
  height: 30px;
}
.filters__column {
  flex: 0 0 190px;
  height: 30px;
  font-size: 12px;
}
.filters__op {
  flex: 0 0 130px;
  height: 30px;
  font-size: 12px;
}
.filters__value {
  flex: 1;
  min-width: 80px;
  height: 30px;
  font-size: 12px;
}
/* Square, and it takes the accent on hover — removing is the destructive act here. */
.filters__remove {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.filters__remove:hover {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}
.filters__raw {
  margin-top: 12px;
}
.filters__raw .input {
  height: 30px;
  font-size: 12px;
}
.filters__hint,
.filters__empty {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-dim);
}
.filters__hint code {
  font-family: var(--font-mono);
  color: var(--text-secondary);
}
</style>
