<script setup lang="ts">
import { computed, markRaw, ref, watch } from 'vue'
import { format as formatSql } from 'sql-formatter'
import type { CellValue, ColumnMeta } from '@shared/types'
import { statementAt, statementsInRange } from '@shared/sql/statements'
import SqlEditor from '../components/SqlEditor.vue'
import ResultsPanel from '../components/ResultsPanel.vue'
import SplitPane from '../components/SplitPane.vue'
import type { QueryTab } from '../stores/tabs'
import { useTabStore } from '../stores/tabs'
import { useSchemaStore } from '../stores/schema'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toasts'
import { useConnectionStore } from '../stores/connections'
import { useCredentialsStore } from '../stores/credentials'
import { useLibraryStore } from '../stores/library'
import { api } from '../lib/api'

const props = defineProps<{ tab: QueryTab }>()
const emit = defineEmits<{
  (event: 'export', columns: ColumnMeta[], rows: CellValue[][]): void
}>()

const tabs = useTabStore()
const schema = useSchemaStore()
const settings = useSettingsStore()
const toasts = useToastStore()
const connections = useConnectionStore()
const credentials = useCredentialsStore()
const library = useLibraryStore()

const editor = ref<InstanceType<typeof SqlEditor> | null>(null)
const editorHeight = ref(336)
const cursor = ref(0)

const sql = computed({
  get: () => props.tab.sql,
  set: (value: string) => tabs.update<QueryTab>(props.tab.id, { sql: value, dirty: true })
})

/** lang-sql wants bare table names as well as schema-qualified ones. */
const completionSchema = computed(() => {
  const out: Record<string, string[]> = {}
  for (const [qualified, columns] of Object.entries(schema.autocomplete)) {
    out[qualified] = columns
    const bare = qualified.split('.').slice(-1)[0]
    if (bare && !(bare in out)) out[bare] = columns
  }
  return out
})

const currentStatement = computed(() => statementAt(props.tab.sql, cursor.value))

async function run(text?: string): Promise<void> {
  const body = (text ?? props.tab.sql).trim()
  if (!body) return
  if (props.tab.running) {
    toasts.info('A query is already running in this tab')
    return
  }

  const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  tabs.update<QueryTab>(props.tab.id, { running: true, executionId })

  try {
    const result = await api.runQuery({
      connectionId: props.tab.connectionId,
      sql: body,
      maxRows: settings.settings.maxResultRows,
      executionId
    })
    // markRaw keeps the (potentially huge) result set out of the reactivity
    // graph; it is only ever replaced, never mutated field by field.
    tabs.update<QueryTab>(props.tab.id, {
      result: markRaw(result),
      running: false,
      executionId: null
    })

    const failed = result.statements.find((statement) => statement.error)
    if (failed?.error && !offerCredentialFix(failed.error, () => run(text))) {
      toasts.error('Query failed', failed.error.message)
    }
    void library.loadHistory()
  } catch (error) {
    tabs.update<QueryTab>(props.tab.id, { running: false, executionId: null })
    if (!offerCredentialFix(error, () => run(text))) toasts.fromError('Query failed', error)
  }
}

/**
 * A session that ran out mid-query is worth a paste box, not a toast — the
 * query itself was fine and can be rerun once the credentials are fresh.
 */
function offerCredentialFix(error: unknown, retry: () => Promise<void>): boolean {
  const connection = connections.saved.find((entry) => entry.id === props.tab.connectionId)
  return credentials.offerRefresh(connection, error, retry)
}

function runSelection(): void {
  const selection = editor.value?.getSelection()
  if (!selection || selection.text.trim() === '') {
    const statements = statementsInRange(props.tab.sql, selection?.from ?? 0, selection?.to ?? 0)
    void run(statements.map((statement) => statement.text).join(';\n'))
    return
  }
  void run(selection.text)
}

function runCurrent(): void {
  const statement = statementAt(props.tab.sql, editor.value?.getCursor() ?? cursor.value)
  if (!statement) return
  void run(statement.text)
}

async function cancel(): Promise<void> {
  if (!props.tab.executionId) return
  const cancelled = await api.cancelQuery(props.tab.connectionId, props.tab.executionId)
  toasts.info(cancelled ? 'Cancellation requested' : 'Nothing to cancel')
}

function formatDocument(): void {
  try {
    const formatted = formatSql(props.tab.sql, {
      language: 'transactsql',
      keywordCase: settings.settings.formatterKeywordCase === 'preserve'
        ? 'preserve'
        : settings.settings.formatterKeywordCase,
      tabWidth: settings.settings.formatterIndent
    })
    editor.value?.setValue(formatted)
  } catch (error) {
    toasts.fromError('Could not format this SQL', error)
  }
}

async function save(): Promise<void> {
  const name = props.tab.savedQueryId
    ? props.tab.title
    : prompt('Save query as:', props.tab.title === 'Query' ? 'Untitled query' : props.tab.title)
  if (!name) return
  try {
    const record = await library.saveQuery({
      id: props.tab.savedQueryId,
      name,
      sql: props.tab.sql,
      connectionId: props.tab.connectionId
    })
    tabs.update<QueryTab>(props.tab.id, {
      savedQueryId: record.id,
      title: record.name,
      dirty: false
    })
    toasts.success(`Saved “${record.name}”`)
  } catch (error) {
    toasts.fromError('Could not save the query', error)
  }
}

async function openFile(): Promise<void> {
  const filePath = await api.openFile()
  if (!filePath) return
  const text = await api.readTextFile(filePath)
  editor.value?.setValue(text)
  const name = filePath.split(/[\\/]/).pop() ?? 'Query'
  tabs.update<QueryTab>(props.tab.id, { title: name, dirty: false })
}

async function saveToFile(): Promise<void> {
  const saved = await api.saveTextFile(props.tab.sql, `${props.tab.title}.sql`)
  if (saved) toasts.success('Saved to file', saved)
}

watch(
  () => props.tab.id,
  () => {
    cursor.value = props.tab.cursor
  }
)

function onCursor(offset: number): void {
  cursor.value = offset
  tabs.update<QueryTab>(props.tab.id, { cursor: offset })
}

/**
 * The status bar reads this, so it has to be pushed rather than computed there.
 *
 * Watch the line number, not the statement: `statementAt` builds a fresh object
 * every call, and writing to the store replaces the tab object this computed
 * reads from — so watching the object would re-fire on its own write, forever.
 */
watch(
  () => currentStatement.value?.startLine ?? null,
  (line) => {
    tabs.update<QueryTab>(props.tab.id, { statementLine: line })
  },
  { immediate: true }
)

defineExpose({
  run: () => run(),
  runSelection,
  runCurrent,
  cancel,
  format: formatDocument,
  save,
  saveAs: saveToFile,
  openFile,
  focus: () => editor.value?.focus(),
  insert: (text: string) => editor.value?.insertText(text)
})
</script>

<template>
  <div class="query">
    <SplitPane v-model="editorHeight" direction="vertical" :min="100" :max="900">
      <template #first>
        <div class="query__editor">
          <div class="query__toolbar">
            <!-- Run is the only filled control on this screen. -->
            <button
              class="btn btn--primary"
              :disabled="tab.running"
              title="Ctrl+Enter"
              @click="run()"
            >
              ▶ Run
              <span class="query__key mono">CTRL ⏎</span>
            </button>
            <button class="btn" title="Ctrl+Shift+Enter" @click="runSelection">
              Run selection
            </button>
            <button class="btn" title="Ctrl+Alt+Enter" @click="runCurrent">Run statement</button>
            <button v-if="tab.running" class="btn btn--danger" @click="cancel">■ Cancel</button>
            <div class="query__spacer"></div>
            <button class="btn btn--muted" title="Ctrl+Shift+F" @click="formatDocument">
              Format
            </button>
            <button class="btn btn--muted" title="Ctrl+O" @click="openFile">Open…</button>
            <button class="btn btn--muted" title="Ctrl+S" @click="save">Save</button>
          </div>

          <SqlEditor
            ref="editor"
            v-model="sql"
            :schema="completionSchema"
            :theme="settings.resolvedTheme"
            :font-family="settings.settings.editorFontFamily"
            :font-size="settings.settings.fontSize"
            @cursor="onCursor"
            @run="run()"
            @run-selection="runSelection"
            @run-current="runCurrent"
            @save="save"
          />

        </div>
      </template>

      <template #second>
        <ResultsPanel
          :result="tab.result"
          :running="tab.running"
          @export="(columns, rows) => emit('export', columns, rows)"
        />
      </template>
    </SplitPane>
  </div>
</template>

<style scoped>
.query {
  height: 100%;
  min-height: 0;
}
.query__editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border-bottom: var(--rule) solid var(--border-strong);
}
.query__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--h-commandbar);
  padding: 0 12px;
  border-bottom: var(--rule) solid var(--border-strong);
  background: var(--bg-surface);
  flex: 0 0 auto;
}
.query__toolbar .btn {
  flex: 0 0 auto;
}
.query__key {
  font-size: 10px;
  opacity: 0.75;
}
.query__spacer {
  flex: 1;
}
</style>
