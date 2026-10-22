<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { format as formatSql } from 'sql-formatter'
import type { CellValue, ColumnMeta } from '@shared/types'
import { statementAt, statementsInRange } from '@shared/sql/statements'
import {
  COMMIT_SQL,
  ROLLBACK_SQL,
  canCommit,
  lostSessionNote,
  sameDatabase,
  transactionAge,
  transactionOpen
} from '@shared/sessions'
import AppIcon from '../components/AppIcon.vue'
import SqlEditor from '../components/SqlEditor.vue'
import ResultsPanel from '../components/ResultsPanel.vue'
import SplitPane from '../components/SplitPane.vue'
import NameDialog from '../components/NameDialog.vue'
import type { QueryTab } from '../stores/tabs'
import { useTabStore } from '../stores/tabs'
import { useConnectionStore } from '../stores/connections'
import { useSchemaStore } from '../stores/schema'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toasts'
import { useLibraryStore } from '../stores/library'
import { useUiStateStore } from '../stores/uiState'
import { useRowPanel } from '../lib/rowPanel'
import { runQueryTab } from '../lib/runQueryTab'
import { api } from '../lib/api'

const props = defineProps<{ tab: QueryTab }>()
const emit = defineEmits<{
  (event: 'export', columns: ColumnMeta[], rows: CellValue[][]): void
}>()

const tabs = useTabStore()
const connections = useConnectionStore()
const schema = useSchemaStore()
const settings = useSettingsStore()
const toasts = useToastStore()
const library = useLibraryStore()
const uiState = useUiStateStore()

const editor = ref<InstanceType<typeof SqlEditor> | null>(null)
/** Shared by every query tab, and kept across restarts: the last drag decides it. */
const editorHeight = ref(uiState.state.queryEditorHeight)
watch(editorHeight, (height) => uiState.remember({ queryEditorHeight: height }))
const cursor = ref(0)

/** The results' row panel, which belongs to this tab and not to the window. */
const showRowPanel = useRowPanel(() => props.tab)

const sql = computed({
  get: () => props.tab.sql,
  set: (value: string) => tabs.update<QueryTab>(props.tab.id, { sql: value, dirty: true })
})

// --- a routine's changes -----------------------------------------------------

/** What the editor marks changes against: a routine's stored definition. */
const baseline = computed(() => props.tab.routine?.baseline ?? null)
const changeCount = computed(() => props.tab.changeCount ?? 0)

const changesLabel = computed(() => {
  const count = changeCount.value
  if (count === 0) return 'No changes'
  return `${count} ${count === 1 ? 'change' : 'changes'}`
})

const changesTitle = computed(() => {
  const routine = props.tab.routine
  if (!routine) return ''
  const where = routine.database ? ` in ${routine.database}` : ''
  return (
    `Compared with ${routine.schema}.${routine.name} as it is stored${where}. ` +
    'Click a mark beside the line numbers to see what was there, or to revert that change ' +
    'alone. Running the whole script saves it.'
  )
})

/** Kept on the tab, which the strip's dot and a remounted view both read. */
function onChanges(count: number): void {
  if ((props.tab.changeCount ?? 0) === count) return
  tabs.update<QueryTab>(props.tab.id, { changeCount: count })
}

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

// --- the tab's session ---------------------------------------------------------

/**
 * The database the tab's next statement runs in, said only when it is not the
 * sidebar's: after a `USE` of its own, or on a routine's tab, which stays in
 * its routine's database.
 */
const tabDatabase = computed(() => {
  const database = props.tab.session?.database ?? props.tab.routine?.database
  if (!database) return null
  return sameDatabase(database, connections.activeStatus?.currentDatabase) ? null : database
})

const inTransaction = computed(() => transactionOpen(props.tab.session))

/** Ticks once a second while a transaction is open, for the age said beside it. */
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
watch(
  inTransaction,
  (open) => {
    if (ticker) clearInterval(ticker)
    ticker = null
    if (!open) return
    now.value = Date.now()
    ticker = setInterval(() => (now.value = Date.now()), 1000)
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})

const transactionLabel = computed(() => {
  const age = transactionAge(props.tab.session?.transactionSince, new Date(now.value))
  return age ? `Transaction open · ${age}` : 'Transaction open'
})

/** Commit and Rollback are runs of the tab, so they show in its results and history. */
function commit(): void {
  void runQueryTab(props.tab.id, COMMIT_SQL)
}

function rollBack(): void {
  void runQueryTab(props.tab.id, ROLLBACK_SQL)
}

/** Runs the tab, or the part of it given; see `runQueryTab`. */
function run(text?: string): Promise<boolean> {
  return runQueryTab(props.tab.id, text)
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

/** Open while a first save is asking what to call the query. */
const naming = ref(false)

function save(): void {
  // A query that is already in the library keeps its name; only the first
  // save has to ask for one.
  if (props.tab.savedQueryId) void saveAs(props.tab.title)
  else naming.value = true
}

async function saveAs(name: string): Promise<void> {
  naming.value = false
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
  toggleRowPanel: () => {
    showRowPanel.value = !showRowPanel.value
  },
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
              <AppIcon name="play" :size="12" />
              Run
              <span class="query__key">
                Ctrl
                <AppIcon name="corner-down-left" :size="11" />
              </span>
            </button>
            <button class="btn" title="Ctrl+Shift+Enter" @click="runSelection">
              Run selection
            </button>
            <button class="btn" title="Ctrl+Alt+Enter" @click="runCurrent">Run statement</button>
            <button v-if="tab.running" class="btn btn--danger" @click="cancel">
              <AppIcon name="stop" :size="12" />
              Cancel
            </button>
            <div class="query__spacer"></div>

            <!-- Where the tab runs, when that is not where the sidebar is. -->
            <span
              v-if="tabDatabase"
              class="badge query__database"
              :title="`This tab's session is in ${tabDatabase}; the sidebar is in ${connections.activeStatus?.currentDatabase ?? 'another database'}`"
            >
              <AppIcon name="database" :size="11" />
              {{ tabDatabase }}
            </span>

            <!-- A transaction left open stays open, holding its locks, until
                 it is committed or rolled back here — or asked about when the
                 tab would close. -->
            <template v-if="inTransaction">
              <span
                class="query__transaction"
                title="A transaction is open in this tab's session. It holds its locks until it is committed or rolled back."
              >
                <AppIcon name="clock" :size="12" />
                {{ transactionLabel }}
              </span>
              <button
                class="btn"
                :disabled="tab.running || !canCommit(tab.session)"
                :title="
                  canCommit(tab.session)
                    ? 'Commit everything the transaction has done'
                    : 'An error has doomed this transaction: it can only be rolled back'
                "
                @click="commit"
              >
                Commit
              </button>
              <button
                class="btn"
                :disabled="tab.running"
                title="Undo everything the transaction has done"
                @click="rollBack"
              >
                Rollback
              </button>
            </template>

            <!-- Said before Run rather than after it: a script that writes is
                 turned down whole, before any of it is sent. -->
            <span
              v-if="connections.readOnly"
              class="badge query__readonly"
              title="This connection is read-only: a script with a statement that would change the database is not run"
            >
              <AppIcon name="lock" :size="11" />
              Read-only
            </span>

            <!-- A routine's tab says how far it has moved from what is stored,
                 and steps through the changes the gutter marks. -->
            <template v-if="tab.routine">
              <span
                class="query__changes mono"
                :class="{ 'query__changes--none': changeCount === 0 }"
                :title="changesTitle"
              >
                <span v-if="changeCount > 0" class="query__changes-dot"></span>
                {{ changesLabel }}
              </span>
              <div class="seg query__nav">
                <button
                  class="seg__opt"
                  :disabled="changeCount === 0"
                  title="Previous change (Shift+Alt+F5)"
                  aria-label="Previous change"
                  @click="editor?.previousChange()"
                >
                  <AppIcon name="chevron-left" :size="14" />
                </button>
                <button
                  class="seg__opt"
                  :disabled="changeCount === 0"
                  title="Next change (Alt+F5)"
                  aria-label="Next change"
                  @click="editor?.nextChange()"
                >
                  <AppIcon name="chevron-right" :size="14" />
                </button>
              </div>
              <button
                class="btn btn--muted"
                :disabled="changeCount === 0"
                title="Put every change back the way it is stored (Ctrl+Z takes it back)"
                @click="editor?.revertAllChanges()"
              >
                Revert all
              </button>
              <div class="divider-v"></div>
            </template>

            <button class="btn btn--muted" title="Ctrl+Shift+F" @click="formatDocument">
              <AppIcon name="align-left" :size="14" />
              Format
            </button>
            <button class="btn btn--muted" title="Ctrl+O" @click="openFile">
              <AppIcon name="folder-open" :size="14" />
              Open…
            </button>
            <button class="btn btn--muted" title="Ctrl+S" @click="save">
              <AppIcon name="save" :size="14" />
              Save
            </button>
          </div>

          <SqlEditor
            ref="editor"
            v-model="sql"
            :schema="completionSchema"
            :theme="settings.resolvedTheme"
            :font-family="settings.settings.editorFontFamily"
            :font-size="settings.settings.fontSize"
            :baseline="baseline"
            @changes="onChanges"
            @cursor="onCursor"
            @run="run()"
            @run-selection="runSelection"
            @run-current="runCurrent"
            @save="save"
          />

        </div>
      </template>

      <template #second>
        <div class="query__results">
          <!-- Said once, until the next run: what went with a lost session. -->
          <div v-if="tab.sessionLost" class="query__notice" role="status">
            <AppIcon name="info" :size="12" />
            <span>{{ lostSessionNote(tab.sessionLost) }}</span>
          </div>
          <ResultsPanel
            v-model:show-row-panel="showRowPanel"
            class="query__results-panel"
            :result="tab.result"
            :running="tab.running"
            @export="(columns, rows) => emit('export', columns, rows)"
          />
        </div>
      </template>
    </SplitPane>

    <NameDialog
      v-if="naming"
      title="Save query"
      :initial="tab.title === 'Query' ? 'Untitled query' : tab.title"
      @confirm="saveAs"
      @close="naming = false"
    />
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
}
.query__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--h-commandbar);
  padding: 0 10px 0 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  flex: 0 0 auto;
}
.query__toolbar .btn {
  flex: 0 0 auto;
}
.query__readonly {
  flex: 0 0 auto;
  gap: 4px;
}
/* The shortcut, set inside the Run button as a faint key cap. */
.query__key {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 18px;
  margin: 0 -4px 0 4px;
  padding: 0 5px;
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--accent-text) 16%, transparent);
  font-size: 11px;
  font-weight: 500;
  opacity: 0.9;
}
.query__spacer {
  flex: 1;
}
.query__database {
  flex: 0 0 auto;
  gap: 4px;
}
/* Staged work's colour, as an edge and its text: never a fill over the toolbar. */
.query__transaction {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  height: 22px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border-strong));
  border-radius: var(--radius-xs);
  color: var(--warning);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.query__results {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.query__results-panel {
  flex: 1 1 auto;
  min-height: 0;
}
.query__notice {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border-subtle);
  border-left: 2px solid var(--warning);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 12px;
}
.query__changes {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.query__changes--none {
  color: var(--text-muted);
}
/* The gutter's colour for a changed line, so the count reads as those marks. */
.query__changes-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warning);
}
.query__nav .seg__opt {
  width: 26px;
  padding: 0;
}
</style>
