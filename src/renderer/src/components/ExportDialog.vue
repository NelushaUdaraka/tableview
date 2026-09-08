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

const FORMATS: { value: ExportFormat; label: string; title: string }[] = [
  { value: 'csv', label: 'CSV', title: 'Comma-separated values' },
  { value: 'tsv', label: 'TSV', title: 'Tab-separated values' },
  { value: 'json', label: 'JSON', title: 'JSON array' },
  { value: 'jsonl', label: 'JSONL', title: 'JSON Lines' },
  { value: 'sql', label: 'SQL', title: 'SQL INSERT statements' },
  { value: 'markdown', label: 'MD', title: 'Markdown table' }
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
    kicker="Export"
    :title="`${tableName || 'Results'} · ${rows.length.toLocaleString()} rows`"
    :subtitle="`${columns.length} columns`"
    width="560px"
    @close="emit('close')"
  >
    <div class="export">
      <div class="field">
        <span class="field__label">Format</span>
        <div class="seg export__formats">
          <button
            v-for="entry in FORMATS"
            :key="entry.value"
            class="seg__opt"
            :class="{ 'seg__opt--on': format === entry.value }"
            :title="entry.title"
            @click="format = entry.value"
          >
            {{ entry.label }}
          </button>
        </div>
      </div>

      <div class="export__row">
        <label v-if="isDelimited" class="field" style="flex: 0 0 130px">
          <span class="field__label">Delimiter</span>
          <input v-model="delimiter" class="input" maxlength="3" />
        </label>
        <label class="field" style="flex: 0 0 160px">
          <span class="field__label">NULL as</span>
          <input v-model="nullString" class="input" placeholder="(empty)" />
        </label>
      </div>

      <label v-if="isDelimited || format === 'markdown'" class="checkbox">
        <input v-model="includeHeader" type="checkbox" />
        <span>Include a header row</span>
      </label>

      <div class="field">
        <span class="field__label">Preview</span>
        <pre class="export__preview selectable">{{ preview }}</pre>
      </div>
    </div>

    <template #footer>
      <button class="btn btn--muted export__copy" @click="copy">Copy to clipboard</button>
      <button class="btn btn--muted" @click="emit('close')">Cancel</button>
      <button class="btn btn--primary" :disabled="busy" @click="save">
        <span v-if="busy" class="spinner"></span>
        Save file
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.export {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.export__row {
  display: flex;
  gap: 16px;
  align-items: flex-end;
}
/* Six equal cells, so the whole set reads as one ruled strip. */
.export__formats {
  display: flex;
}
.export__formats .seg__opt {
  flex: 1;
  height: 32px;
  justify-content: center;
  padding: 0 8px;
  font-size: 12px;
}
.export__preview {
  margin: 0;
  padding: 12px;
  max-height: 260px;
  overflow: auto;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre;
}
/* The one footer action that is not about finishing: pushed away from the pair. */
.export__copy {
  margin-right: auto;
}
</style>
