<script setup lang="ts">
/**
 * Importing a CSV file into a table: which file column fills which table
 * column, what an empty cell means, and every problem — row by row — before
 * anything is sent.
 *
 * Nothing goes to the server from here. The rows that pass are staged as
 * inserts in the table's grid, through the same pipeline as Add row, to be
 * looked over, edited, and applied in one transaction — or discarded.
 */
import { computed, ref, watch } from 'vue'
import type { TableStructure } from '@shared/types'
import { DELIMITERS, parseDelimited, type Delimiter } from '@shared/csv'
import {
  importableColumns,
  matchColumns,
  planImport,
  positionalMapping,
  unfilledRequired,
  type ColumnMapping,
  type EmptyAs,
  type ImportRow
} from '@shared/import'
import BaseModal from './BaseModal.vue'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  structure: TableStructure
  fileName: string
  text: string
}>()

const emit = defineEmits<{
  (event: 'stage', rows: ImportRow[]): void
  (event: 'close'): void
}>()

const initial = parseDelimited(props.text)
const delimiter = ref<Delimiter>(initial.delimiter)
const records = computed(() =>
  delimiter.value === initial.delimiter ? initial.rows : parseDelimited(props.text, delimiter.value).rows
)

const columns = computed(() => importableColumns(props.structure.columns))
/** How many fields the widest of the first records has. */
const width = computed(() => Math.max(0, ...records.value.slice(0, 50).map((record) => record.length)))

/** A first record that names any of the table's columns is taken for a header. */
function looksLikeHeader(): boolean {
  const first = records.value[0] ?? []
  const matched = matchColumns(first, columns.value)
  return Object.values(matched).some((index) => index !== null)
}

const header = ref(looksLikeHeader())
const emptyAs = ref<EmptyAs>('null')

function startingMapping(): ColumnMapping {
  return header.value
    ? matchColumns(records.value[0] ?? [], columns.value)
    : positionalMapping(width.value, columns.value)
}
const mapping = ref<ColumnMapping>(startingMapping())
watch([header, delimiter], () => {
  mapping.value = startingMapping()
})

/** The file's columns as the mapping offers them: by header name, or by position. */
const fileColumns = computed(() =>
  Array.from({ length: width.value }, (_, index) => {
    const name = header.value ? (records.value[0]?.[index] ?? '').trim() : ''
    return { index, label: name ? `${index + 1}. ${name}` : `Column ${index + 1}` }
  })
)

const firstValues = computed(() => records.value[header.value ? 1 : 0] ?? [])
const dataCount = computed(() => Math.max(0, records.value.length - (header.value ? 1 : 0)))

const plan = computed(() =>
  planImport(records.value, {
    header: header.value,
    mapping: mapping.value,
    columns: columns.value,
    emptyAs: emptyAs.value
  })
)
const missing = computed(() => unfilledRequired(columns.value, mapping.value))
const mappedColumns = computed(() => columns.value.filter((column) => mapping.value[column.name] != null))

/** The first rows as they would be staged, problems and all. */
const PREVIEW_ROWS = 8
const preview = computed(() => {
  const start = header.value ? 1 : 0
  return records.value.slice(start, start + PREVIEW_ROWS).map((record, offset) => {
    const line = start + offset + 1
    const problems = new Map(
      plan.value.problems.filter((problem) => problem.line === line).map((p) => [p.column, p.message])
    )
    return {
      line,
      cells: mappedColumns.value.map((column) => ({
        text: record[mapping.value[column.name]!] ?? '',
        problem: problems.get(column.name) ?? null
      }))
    }
  })
})

const SHOWN_PROBLEMS = 100
const canStage = computed(
  () => missing.value.length === 0 && mappedColumns.value.length > 0 && plan.value.rows.length > 0
)
const stageLabel = computed(() => {
  const rows = plan.value.rows.length
  const label = `Stage ${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'}`
  return plan.value.rejected > 0 ? `${label}, leave out ${plan.value.rejected.toLocaleString()}` : label
})

function setMapping(column: string, value: string): void {
  mapping.value = { ...mapping.value, [column]: value === '' ? null : Number(value) }
}

function typeOf(column: { fullType: string; nullable: boolean; defaultValue: string | null }): string {
  return column.fullType
}

function requiredHint(column: { nullable: boolean; defaultValue: string | null }): string {
  if (column.nullable) return ''
  return column.defaultValue ? 'has a default' : 'required'
}
</script>

<template>
  <BaseModal
    kicker="Import"
    :title="`Import into ${structure.schema}.${structure.name}`"
    :subtitle="`${fileName} · ${dataCount.toLocaleString()} ${dataCount === 1 ? 'row' : 'rows'}`"
    width="860px"
    @close="emit('close')"
  >
    <div class="import">
      <div class="import__options">
        <label class="field import__field">
          <span class="field__label">Separated by</span>
          <select v-model="delimiter" class="select select--sm">
            <option v-for="entry in DELIMITERS" :key="entry.label" :value="entry.value">
              {{ entry.label }}
            </option>
          </select>
        </label>
        <label class="checkbox import__check">
          <input v-model="header" type="checkbox" />
          <span>The first row names the columns</span>
        </label>
        <div class="field import__field">
          <span class="field__label">An empty cell is</span>
          <div class="seg">
            <button
              class="seg__opt"
              :class="{ 'seg__opt--on': emptyAs === 'null' }"
              @click="emptyAs = 'null'"
            >
              NULL
            </button>
            <button
              class="seg__opt"
              :class="{ 'seg__opt--on': emptyAs === 'empty' }"
              @click="emptyAs = 'empty'"
            >
              Empty text
            </button>
          </div>
        </div>
      </div>

      <section class="import__section">
        <div class="caps import__heading">Columns</div>
        <table class="mapping">
          <tbody>
            <tr v-for="column in columns" :key="column.name">
              <td class="mapping__name mono truncate">{{ column.name }}</td>
              <td class="mapping__type mono">{{ typeOf(column) }}</td>
              <td class="mapping__hint">{{ requiredHint(column) }}</td>
              <td class="mapping__arrow"><AppIcon name="arrow-left" :size="13" /></td>
              <td class="mapping__pick">
                <select
                  class="select select--sm"
                  :aria-label="`File column for ${column.name}`"
                  :value="mapping[column.name] ?? ''"
                  @change="setMapping(column.name, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">— leave out —</option>
                  <option v-for="file in fileColumns" :key="file.index" :value="file.index">
                    {{ file.label }}
                  </option>
                </select>
              </td>
              <td class="mapping__sample mono truncate">
                <template v-if="mapping[column.name] != null">
                  {{ firstValues[mapping[column.name]!] ?? '' }}
                </template>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="import__note">
          Identity, computed and rowversion columns are filled in by the server and are not offered.
          A column left out takes its default.
        </p>
      </section>

      <div v-if="missing.length" class="import__banner import__banner--error" role="alert">
        <AppIcon name="circle-x" :size="14" />
        <span>
          No file column fills
          <strong class="mono">{{ missing.join(', ') }}</strong>, which
          {{ missing.length === 1 ? 'needs' : 'need' }} a value and
          {{ missing.length === 1 ? 'has' : 'have' }} no default.
        </span>
      </div>

      <section v-if="mappedColumns.length" class="import__section">
        <div class="caps import__heading">Preview</div>
        <div class="preview">
          <table>
            <thead>
              <tr>
                <th class="num">Line</th>
                <th v-for="column in mappedColumns" :key="column.name" class="mono">{{ column.name }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in preview" :key="row.line">
                <td class="num dim">{{ row.line }}</td>
                <td
                  v-for="(cell, index) in row.cells"
                  :key="index"
                  class="mono"
                  :class="{ 'preview__bad': cell.problem }"
                  :title="cell.problem ?? undefined"
                >
                  <span v-if="cell.text === ''" class="dim">{{ emptyAs === 'null' ? 'NULL' : '' }}</span>
                  <template v-else>{{ cell.text }}</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="plan.problems.length" class="import__section">
        <div class="caps import__heading import__heading--warn">
          {{ plan.rejected.toLocaleString() }} {{ plan.rejected === 1 ? 'row has' : 'rows have' }} problems
        </div>
        <ul class="problems">
          <li v-for="(problem, index) in plan.problems.slice(0, SHOWN_PROBLEMS)" :key="index">
            <span class="problems__line num">Line {{ problem.line }}</span>
            <span v-if="problem.column" class="mono">{{ problem.column }}</span>
            <span>{{ problem.message }}</span>
          </li>
          <li v-if="plan.problems.length > SHOWN_PROBLEMS" class="dim">
            and {{ (plan.problems.length - SHOWN_PROBLEMS).toLocaleString() }} more
          </li>
        </ul>
      </section>
    </div>

    <template #footer>
      <span class="import__foot-note">Staged rows are sent only when you press Apply.</span>
      <div class="import__spacer"></div>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn--primary" :disabled="!canStage" @click="emit('stage', plan.rows)">
        {{ stageLabel }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.import {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.import__options {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 20px;
}
.import__field {
  gap: 6px;
}
.import__field .select {
  min-width: 140px;
}
.import__check {
  height: var(--h-control);
}
.import__section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.import__heading {
  color: var(--text-muted);
}
.import__heading--warn {
  color: var(--warning);
}
.import__note,
.import__foot-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.import__spacer {
  flex: 1;
}
.import__banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.5;
}
.import__banner > .icon {
  margin-top: 2px;
  flex: 0 0 auto;
}
.import__banner--error {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--text-primary);
}
.import__banner--error > .icon {
  color: var(--danger);
}
.mapping {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.mapping td {
  height: 34px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
}
.mapping__name {
  max-width: 200px;
  color: var(--text-primary);
}
.mapping__type,
.mapping__hint {
  color: var(--text-muted);
  white-space: nowrap;
}
.mapping__arrow {
  color: var(--text-dim);
  width: 1%;
}
.mapping__pick .select {
  width: 200px;
}
.mapping__sample {
  max-width: 180px;
  color: var(--text-secondary);
}
.preview {
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}
.preview table {
  border-collapse: collapse;
  font-size: 12px;
  min-width: 100%;
}
.preview th {
  position: sticky;
  top: 0;
  height: 28px;
  padding: 0 10px;
  background: var(--bg-app);
  color: var(--text-muted);
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}
.preview td {
  height: 26px;
  max-width: 220px;
  padding: 0 10px;
  border-top: 1px solid var(--border);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview .num {
  text-align: right;
}
.preview__bad {
  box-shadow: inset 0 -2px 0 var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}
.problems {
  max-height: 160px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
  font-size: 12px;
}
.problems li {
  display: flex;
  gap: 8px;
  padding: 3px 0;
  color: var(--text-secondary);
}
.problems__line {
  min-width: 64px;
  color: var(--text-muted);
}
</style>
