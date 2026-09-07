<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CellValue, ColumnMeta, ExportFormat } from '@shared/types'
import { exportRows } from '@shared/export'
import BaseModal from './BaseModal.vue'
import { useToastStore } from '../stores/toasts'
import { api } from '../lib/api'

const props = defineProps<{
  columns: ColumnMeta[]
  rows: CellValue[][]
  tableName?: string
}>()

const emit = defineEmits<{ (event: 'close'): void }>()
const toasts = useToastStore()

const format = ref<ExportFormat>('csv')
const includeHeader = ref(true)
const delimiter = ref(',')
const nullString = ref('')
const busy = ref(false)

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'csv', label: 'CSV' },
  { value: 'tsv', label: 'TSV' },
  { value: 'json', label: 'JSON' },
  { value: 'jsonl', label: 'JSON Lines' },
  { value: 'sql', label: 'SQL INSERTs' },
  { value: 'markdown', label: 'Markdown table' }
]

const isDelimited = computed(() => format.value === 'csv' || format.value === 'tsv')

const preview = computed(() => {
  const sample = props.rows.slice(0, 12)
  try {
    return exportRows(props.columns, sample, {
      format: format.value,
      includeHeader: includeHeader.value,
      delimiter: isDelimited.value ? delimiter.value : undefined,
      nullString: nullString.value,
      tableName: props.tableName
    })
  } catch (error) {
    return String(error)
  }
})

async function save(): Promise<void> {
  busy.value = true
  try {
    const target = await api.exportToFile({
      format: format.value,
      includeHeader: includeHeader.value,
      delimiter: isDelimited.value ? delimiter.value : undefined,
      nullString: nullString.value,
      tableName: props.tableName,
      columns: props.columns,
      rows: props.rows
    })
    if (target) {
      toasts.success(`Exported ${props.rows.length} rows`, target)
      emit('close')
    }
  } catch (error) {
    toasts.fromError('Export failed', error)
  } finally {
    busy.value = false
  }
}

async function copy(): Promise<void> {
  const text = exportRows(props.columns, props.rows, {
    format: format.value,
    includeHeader: includeHeader.value,
    delimiter: isDelimited.value ? delimiter.value : undefined,
    nullString: nullString.value,
    tableName: props.tableName
  })
  await api.copyToClipboard(text)
  toasts.info('Copied to clipboard')
  emit('close')
}
</script>

<template>
  <BaseModal
    title="Export results"
    :subtitle="`${rows.length.toLocaleString()} rows · ${columns.length} columns`"
    width="620px"
    @close="emit('close')"
  >
    <div class="export">
      <div class="export__row">
        <label class="field" style="flex: 1">
          <span class="field__label">Format</span>
          <select v-model="format" class="select">
            <option v-for="entry in FORMATS" :key="entry.value" :value="entry.value">
              {{ entry.label }}
            </option>
          </select>
        </label>
        <label v-if="isDelimited" class="field" style="flex: 0 0 110px">
          <span class="field__label">Delimiter</span>
          <input v-model="delimiter" class="input" maxlength="3" />
        </label>
        <label class="field" style="flex: 0 0 140px">
          <span class="field__label">NULL as</span>
          <input v-model="nullString" class="input" placeholder="(empty)" />
        </label>
      </div>

      <label v-if="isDelimited || format === 'markdown'" class="checkbox">
        <input v-model="includeHeader" type="checkbox" />
        <span>Include header row</span>
      </label>

      <div class="field">
        <span class="field__label">Preview (first 12 rows)</span>
        <pre class="export__preview selectable">{{ preview }}</pre>
      </div>
    </div>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn" @click="copy">Copy to clipboard</button>
      <button class="btn btn--primary" :disabled="busy" @click="save">
        <span v-if="busy" class="spinner"></span>
        Save to file…
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.export {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.export__row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
.export__preview {
  margin: 0;
  padding: 10px;
  max-height: 260px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
}
</style>
