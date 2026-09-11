<script setup lang="ts">
/**
 * Table browser with staged editing.
 *
 * Edits are held locally until "Apply", then sent as one change set that the
 * main process runs inside a transaction. Rows are addressed by their primary
 * key; a table without one falls back to matching on every column, which the
 * banner warns about because it can match more rows than intended.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import type {
  CellValue,
  ColumnMeta,
  ExportFormat,
  TableChangeSet,
  TableColumn,
  TableFilter,
  TableSort,
  TableStructure
} from '@shared/types'
import BaseModal from '../components/BaseModal.vue'
import DataGrid, { type RowState } from '../components/DataGrid.vue'
import FilterBuilder from '../components/FilterBuilder.vue'
import ContextMenu, { type MenuEntry } from '../components/ContextMenu.vue'
import RowDetailPanel, { type RowField } from '../components/RowDetailPanel.vue'
import SplitPane from '../components/SplitPane.vue'
import TableViewSwitch from '../components/TableViewSwitch.vue'
import { exportRows } from '@shared/export'
import { columnMenuItems } from '../lib/columnMenu'
import { reindexStagedEdits } from '../lib/stagedRows'
import { foreignKeyFilterValue, foreignKeyFilters, foreignKeyTargets } from '@shared/foreignKeys'
import { useBusyStore } from '../stores/busy'
import { useSettingsStore } from '../stores/settings'
import { useSchemaStore } from '../stores/schema'
import { useTabStore } from '../stores/tabs'
import { useToastStore } from '../stores/toasts'
import { useConnectionStore } from '../stores/connections'
import { useCredentialsStore } from '../stores/credentials'
import type { TableTab } from '../stores/tabs'
import { api } from '../lib/api'

const props = defineProps<{ tab: TableTab }>()
const emit = defineEmits<{
  (event: 'export', columns: ColumnMeta[], rows: CellValue[][], name: string): void
  (event: 'open-related', schema: string, table: string, filters: TableFilter[]): void
}>()

const busy = useBusyStore()
const settings = useSettingsStore()
const schemaStore = useSchemaStore()
const tabs = useTabStore()
const toasts = useToastStore()
const connections = useConnectionStore()
const credentials = useCredentialsStore()

const structure = ref<TableStructure | null>(null)
const columns = shallowRef<ColumnMeta[]>([])
// shallowRef: the rows array is replaced wholesale, and its contents must not
// be wrapped in reactive proxies (both for speed and because a proxy cannot
// cross the IPC boundary).
const loadedRows = shallowRef<CellValue[][]>([])
const totalRows = ref<number | null>(null)
const loading = ref(false)
const durationMs = ref(0)
const lastSql = ref('')
const grid = ref<InstanceType<typeof DataGrid> | null>(null)
/**
 * The open context menu.
 *
 * `kind` says which of the two it is: right-clicking a row asks about rows,
 * right-clicking a header asks about a column, and they share one menu
 * component because only one can be open at a time.
 */
const menu = ref<{ kind: 'row' | 'header'; x: number; y: number; row: number; col: number } | null>(
  null
)
const selection = ref<{ rowIndex: number; columnIndex: number } | null>(null)

const offset = ref(0)
const pageSize = ref(settings.settings.pageSize)
const sorts = ref<TableSort[]>([])
const filters = ref<TableFilter[]>([])
const filterMode = ref<'builder' | 'raw'>('builder')
const rawWhere = ref('')
const showFilters = ref(false)

/** Rows the grid has picked out; the focused row when nothing else is. */
const selectedRows = ref<number[]>([])

/** Staged changes. */
const edits = reactive<Record<string, CellValue>>({})
const deletedRows = ref<Set<number>>(new Set())
const newRows = shallowRef<CellValue[][]>([])
const applying = ref(false)

const isView = computed(() => props.tab.objectType === 'view')
const primaryKey = computed(() => structure.value?.primaryKey ?? [])
const hasPrimaryKey = computed(() => primaryKey.value.length > 0)
const editable = computed(() => !isView.value)
/**
 * Whether to warn that edits will match on every column.
 *
 * Only once the structure has actually arrived: it is null while the table
 * opens, which reads as "no primary key" and flashed the warning on every
 * table for as long as the lookup took.
 */
const warnNoPrimaryKey = computed(
  () => Boolean(structure.value) && editable.value && !hasPrimaryKey.value
)

const allRows = computed(() => [...loadedRows.value, ...newRows.value])

const rowStates = computed<RowState[]>(() => {
  const states: RowState[] = loadedRows.value.map((_, index) =>
    deletedRows.value.has(index) ? 'deleted' : 'normal'
  )
  return [...states, ...newRows.value.map(() => 'inserted' as RowState)]
})

const pendingCount = computed(() => {
  const updated = new Set(
    Object.keys(edits)
      .map((key) => Number(key.split(':')[0]))
      .filter((index) => index < loadedRows.value.length && !deletedRows.value.has(index))
  )
  return updated.size + deletedRows.value.size + newRows.value.length
})

watch(pendingCount, (count) => {
  tabs.update<TableTab>(props.tab.id, { pendingEdits: count })
})

const pageRange = computed(() => {
  const from = allRows.value.length === 0 ? 0 : offset.value + 1
  const to = offset.value + loadedRows.value.length
  return `${from.toLocaleString()}–${to.toLocaleString()}`
})

const pageTotal = computed(() =>
  totalRows.value === null ? '?' : totalRows.value.toLocaleString()
)

/** The row count as the command bar states it, beside the table's name. */
const rowCountLabel = computed(() =>
  totalRows.value === null ? '' : `${totalRows.value.toLocaleString()} rows`
)

const canPrevious = computed(() => offset.value > 0)
const canNext = computed(() =>
  totalRows.value === null
    ? loadedRows.value.length === pageSize.value
    : offset.value + pageSize.value < totalRows.value
)

function discard(): void {
  for (const key of Object.keys(edits)) delete edits[key]
  deletedRows.value = new Set()
  newRows.value = []
}

/** Drops one staged cell edit, leaving the rest of the row staged. */
function revertCell(rowIndex: number, columnIndex: number): void {
  delete edits[`${rowIndex}:${columnIndex}`]
}

type PendingChoice = 'apply' | 'discard' | 'cancel'

/**
 * Asks what to do with staged edits that are about to be lost.
 *
 * Reloading the table replaces the rows the edits are keyed against, so they
 * cannot survive it — but silently dropping them is how a page of retyped
 * values disappears on a stray Refresh.
 */
const pendingPrompt = ref<{ resolve: (choice: PendingChoice) => void } | null>(null)

function askAboutPendingEdits(): Promise<PendingChoice> {
  return new Promise((resolve) => {
    pendingPrompt.value = { resolve }
  })
}

function answerPendingPrompt(choice: PendingChoice): void {
  const prompt = pendingPrompt.value
  pendingPrompt.value = null
  prompt?.resolve(choice)
}

/** Runs `action` once the staged edits have been applied or dropped. */
async function withPendingEdits(action: () => void | Promise<void>): Promise<void> {
  if (pendingCount.value > 0) {
    const choice = await askAboutPendingEdits()
    if (choice === 'cancel') return
    if (choice === 'apply') {
      if (!(await apply())) return
    } else {
      discard()
    }
  }
  await action()
}

/** The tab store asks this before leaving or closing this table's tab. */
async function confirmLeave(): Promise<boolean> {
  if (pendingCount.value === 0) return true
  const choice = await askAboutPendingEdits()
  if (choice === 'cancel') return false
  if (choice === 'apply') return apply()
  discard()
  return true
}

async function loadStructure(): Promise<void> {
  try {
    structure.value = await schemaStore.getStructure(
      props.tab.connectionId,
      props.tab.schema,
      props.tab.table
    )
  } catch (error) {
    toasts.fromError('Could not read the table structure', error)
  }
}

/**
 * Fetches the current page.
 *
 * The rows already on screen are left alone until the new ones arrive: the
 * grid dims them and stops answering, and the window's progress bar carries
 * the wait. Sorting a table no longer empties it for the round trip.
 */
async function load(resetOffset = false): Promise<void> {
  if (resetOffset) offset.value = 0
  loading.value = true
  busy.begin()
  try {
    const response = await api.fetchTableData({
      connectionId: props.tab.connectionId,
      schema: props.tab.schema,
      table: props.tab.table,
      offset: offset.value,
      limit: pageSize.value,
      sorts: sorts.value,
      filters: filters.value,
      filterMode: filterMode.value,
      rawWhere: rawWhere.value
    })
    columns.value = response.columns
    loadedRows.value = response.rows
    totalRows.value = response.totalRows
    durationMs.value = response.durationMs
    lastSql.value = response.sql
    discard()
  } catch (error) {
    // A session that ran out mid-browse is fixable in place; retry this load.
    const connection = connections.saved.find((entry) => entry.id === props.tab.connectionId)
    if (!credentials.offerRefresh(connection, error, () => load(resetOffset))) {
      toasts.fromError('Could not load the table', error)
    }
  } finally {
    loading.value = false
    busy.end()
  }
}

onBeforeUnmount(() => {
  tabs.setLeaveGuard(null)
  // A dialog left waiting would keep its caller pending forever.
  if (pendingPrompt.value) answerPendingPrompt('cancel')
})

/** Filters carried on the tab, e.g. from following a foreign key into it. */
function applyTabFilters(): boolean {
  const incoming = props.tab.filters
  if (!incoming || incoming.length === 0) return false
  filters.value = incoming.map((filter) => ({ ...filter }))
  filterMode.value = 'builder'
  rawWhere.value = ''
  // Show them: a table that opens holding three rows should say why.
  showFilters.value = true
  return true
}

onMounted(async () => {
  // A remount starts with no staged edits, so the tab's badge must not claim
  // any left over from the last time this table was open.
  tabs.update<TableTab>(props.tab.id, { pendingEdits: 0 })
  // Leaving this tab unmounts the view and takes the staged edits with it, so
  // the store asks here first.
  tabs.setLeaveGuard(confirmLeave)
  await loadStructure()
  // A primary key gives a stable default order.
  const key = structure.value?.primaryKey ?? []
  sorts.value = key.length ? key.map((column) => ({ column, direction: 'asc' as const })) : []
  const filtered = applyTabFilters()
  await load()
  // Arriving by way of a foreign key means the row that was asked for is the
  // one now on screen; put it straight into the panel.
  if (filtered) await selectFirstRow()
})

// Reopening a table reuses its tab, so new filters arrive as a revision bump
// rather than a fresh mount.
watch(
  () => props.tab.filterRevision,
  async () => {
    await withPendingEdits(async () => {
      if (!applyTabFilters()) return
      await load(true)
      await selectFirstRow()
    })
  }
)

// --- the selected row -------------------------------------------------------

const showRowPanel = computed(() => settings.settings.showRowPanel)
const rowPanelWidth = ref(settings.settings.rowPanelWidth)

/**
 * Selects the first row once the grid has settled.
 *
 * Replacing the columns resets the grid's selection, and that watcher runs on
 * the flush after `load` resolves — so this has to wait for it, or it would
 * select a row and then have the reset clear it again.
 */
async function selectFirstRow(): Promise<void> {
  await nextTick()
  if (allRows.value.length > 0) grid.value?.selectCell(0, 0)
}

function toggleRowPanel(): void {
  void settings.update({ showRowPanel: !settings.settings.showRowPanel })
}

/**
 * Puts one row in the panel, opening the panel if it was closed.
 *
 * The menu entry that leads here names a row, so it has to select that row as
 * well as show the panel — the panel only ever shows the selected one.
 */
function showRowDetails(rowIndex: number, columnIndex: number): void {
  grid.value?.selectCell(rowIndex, columnIndex)
  if (!settings.settings.showRowPanel) void settings.update({ showRowPanel: true })
}

// Dragging the divider emits on every mouse move; only the resting width is
// worth a write to disk.
let widthTimer: ReturnType<typeof setTimeout> | null = null
watch(rowPanelWidth, (width) => {
  if (widthTimer) clearTimeout(widthTimer)
  widthTimer = setTimeout(() => void settings.update({ rowPanelWidth: width }), 500)
})

/** Column index -> the foreign key it participates in. */
const foreignKeys = computed(() =>
  foreignKeyTargets(columns.value, structure.value?.foreignKeys ?? [])
)

/** The same map flattened to labels, which is all the grid needs. */
const foreignKeyLabels = computed<Record<number, string>>(() =>
  Object.fromEntries(
    Object.entries(foreignKeys.value).map(([index, target]) => [index, target.label])
  )
)

/** A row's values as they stand, staged edits included. */
function mergedRow(rowIndex: number): CellValue[] | null {
  const row = allRows.value[rowIndex]
  if (!row) return null
  return columns.value.map((_, index) => {
    const key = `${rowIndex}:${index}`
    return key in edits ? edits[key] : (row[index] ?? null)
  })
}

const rowFields = computed<RowField[]>(() => {
  const current = selection.value
  if (!current) return []
  const row = allRows.value[current.rowIndex]
  if (!row) return []

  return columns.value.map((column, index) => {
    const key = `${current.rowIndex}:${index}`
    const edited = key in edits
    return {
      column,
      value: edited ? edits[key] : (row[index] ?? null),
      edited,
      isPrimaryKey: primaryKey.value.includes(column.name),
      foreignKey: foreignKeyLabels.value[index]
    }
  })
})

const rowLabel = computed(() => {
  const current = selection.value
  if (!current || !allRows.value[current.rowIndex]) return ''
  if (current.rowIndex >= loadedRows.value.length) {
    return `new ${current.rowIndex - loadedRows.value.length + 1}`
  }
  const total = totalRows.value ?? allRows.value.length
  return `${(offset.value + current.rowIndex + 1).toLocaleString()} of ${total.toLocaleString()}`
})

const rowState = computed<RowState>(() =>
  selection.value ? (rowStates.value[selection.value.rowIndex] ?? 'normal') : 'normal'
)

/** Moves the grid's selection, which moves the panel with it. */
function moveSelection(delta: number): void {
  const current = selection.value
  if (!current) return
  const next = current.rowIndex + delta
  if (next < 0 || next >= allRows.value.length) return
  grid.value?.selectCell(next, current.columnIndex)
}

function editSelectedRow(columnIndex: number, value: CellValue): void {
  if (!selection.value) return
  onEdit(selection.value.rowIndex, columnIndex, value)
}

/**
 * Opens the row a foreign key points at, in the referenced table's own tab.
 *
 * The filters are built from the values as they are displayed — a staged edit
 * included — because that is the row the arrow appears to point at.
 */
function followKey(rowIndex: number, columnIndex: number): void {
  const target = foreignKeys.value[columnIndex]
  const row = mergedRow(rowIndex)
  if (!target || !row) return

  const related = foreignKeyFilters(target, columns.value, row)
  if (!related) {
    toasts.info(
      'That reference cannot be followed',
      'The value is NULL, or its type has no text form to filter on.'
    )
    return
  }
  emit('open-related', target.schema, target.table, related)
}

/** Sorts by one column alone, replacing whatever order was in force. */
function sortBy(column: string, direction: 'asc' | 'desc'): void {
  sorts.value = [{ column, direction }]
  void withPendingEdits(() => load(true))
}

/** Appends a column to the existing order, the way Shift-clicking a header does. */
function addSort(column: string, direction: 'asc' | 'desc' = 'asc'): void {
  if (sorts.value.some((sort) => sort.column === column)) return
  sorts.value = [...sorts.value, { column, direction }]
  void withPendingEdits(() => load(true))
}

function clearSorts(): void {
  if (sorts.value.length === 0) return
  sorts.value = []
  void withPendingEdits(() => load(true))
}

function onSort(column: string, additive: boolean): void {
  const existing = sorts.value.find((sort) => sort.column === column)
  if (additive) {
    sorts.value = existing
      ? sorts.value.map((sort) =>
          sort.column === column
            ? { ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
            : sort
        )
      : [...sorts.value, { column, direction: 'asc' }]
  } else {
    sorts.value =
      existing && existing.direction === 'asc'
        ? [{ column, direction: 'desc' }]
        : existing
          ? []
          : [{ column, direction: 'asc' }]
  }
  void withPendingEdits(() => load(true))
}

function onEdit(rowIndex: number, columnIndex: number, value: CellValue): void {
  if (!editable.value) {
    toasts.info('Views cannot be edited')
    return
  }
  edits[`${rowIndex}:${columnIndex}`] = value
}

function addRow(): void {
  if (!editable.value) return
  newRows.value = [...newRows.value, columns.value.map(() => null)]
}

/** Whether the server fills this column in, so a copy must leave it alone. */
function isServerGenerated(columnName: string): boolean {
  const column = structure.value?.columns.find((entry) => entry.name === columnName)
  return Boolean(column?.isIdentity || column?.isComputed)
}

/**
 * Stages an insert holding this row's values.
 *
 * The values have to be staged as edits, not just put in the row: the change
 * set builds an insert out of what has been edited, and a row nobody typed
 * into would go up empty. Identity and computed columns are left out, so the
 * server assigns them.
 */
function duplicateRows(rowIndexes: number[]): void {
  if (!editable.value) return
  for (const rowIndex of [...rowIndexes].sort((a, b) => a - b)) {
    const source = mergedRow(rowIndex)
    if (!source) continue

    const newIndex = loadedRows.value.length + newRows.value.length
    newRows.value = [
      ...newRows.value,
      columns.value.map((column, index) =>
        isServerGenerated(column.name) ? null : (source[index] ?? null)
      )
    ]
    columns.value.forEach((column, index) => {
      if (isServerGenerated(column.name)) return
      edits[`${newIndex}:${index}`] = source[index] ?? null
    })
  }
}

/** Drops every staged edit on these rows, leaving other rows staged. */
function revertRows(rowIndexes: number[]): void {
  const targets = new Set(rowIndexes)
  for (const key of Object.keys(edits)) {
    if (targets.has(Number(key.split(':')[0]))) delete edits[key]
  }
}

function rowsHaveEdits(rowIndexes: number[]): boolean {
  const targets = new Set(rowIndexes)
  return Object.keys(edits).some((key) => targets.has(Number(key.split(':')[0])))
}

/**
 * The rows an action applies to.
 *
 * The grid keeps the row that was right-clicked inside its selection, so this
 * is the selection whenever there is one — and the clicked row on its own for
 * anything that arrives without one.
 */
function targetRows(clicked: number): number[] {
  return selectedRows.value.includes(clicked) && selectedRows.value.length > 0
    ? [...selectedRows.value]
    : [clicked]
}

/**
 * Filters the table down to (or away from) the value that was right-clicked.
 *
 * NULL cannot be compared with `=`, so it maps to the operator that means the
 * same thing — which is also what the filter builder would have produced.
 */
function filterByCell(rowIndex: number, columnIndex: number, exclude: boolean): void {
  const column = columns.value[columnIndex]
  const row = mergedRow(rowIndex)
  if (!column || !row) return

  const value = row[columnIndex] ?? null
  const filter: TableFilter =
    value === null
      ? { column: column.name, operator: exclude ? 'is not null' : 'is null' }
      : {
          column: column.name,
          operator: exclude ? '!=' : '=',
          value: foreignKeyFilterValue(value) ?? String(value)
        }

  void withPendingEdits(() => {
    filters.value = [...filters.value, { ...filter, conjunction: 'AND' }]
    filterMode.value = 'builder'
    showFilters.value = true
    return load(true)
  })
}

/**
 * Opens the filter builder on a row for this column, ready to be filled in.
 *
 * Nothing is applied yet: the operator and the value are the user's to choose,
 * and firing a query off an empty `=` would only throw the page away.
 */
function filterOnColumn(columnIndex: number): void {
  const column = columns.value[columnIndex]
  if (!column) return
  filterMode.value = 'builder'
  filters.value = [...filters.value, { column: column.name, operator: '=', value: '', conjunction: 'AND' }]
  showFilters.value = true
}

/** The two filters that need no value, straight from the header menu. */
function filterNullity(columnIndex: number, operator: 'is null' | 'is not null'): void {
  const column = columns.value[columnIndex]
  if (!column) return
  void withPendingEdits(() => {
    filters.value = [...filters.value, { column: column.name, operator, conjunction: 'AND' }]
    filterMode.value = 'builder'
    showFilters.value = true
    return load(true)
  })
}

function clearFilters(): void {
  if (filters.value.length === 0 && !rawWhere.value) return
  void withPendingEdits(() => {
    filters.value = []
    rawWhere.value = ''
    return load(true)
  })
}

/**
 * Marks stored rows for deletion, and drops staged inserts outright.
 *
 * Marking is a toggle over the whole set: rows that are all marked already
 * unmark together, so the same menu entry undoes what it just did.
 */
function deleteRows(rowIndexes: number[]): void {
  if (!editable.value || rowIndexes.length === 0) return
  const loadedCount = loadedRows.value.length
  const stored = rowIndexes.filter((index) => index < loadedCount)
  const staged = rowIndexes.filter((index) => index >= loadedCount)

  if (stored.length > 0) {
    const next = new Set(deletedRows.value)
    const undo = stored.every((index) => next.has(index))
    for (const index of stored) {
      if (undo) next.delete(index)
      else next.add(index)
    }
    deletedRows.value = next
  }

  if (staged.length > 0) dropStagedRows(staged.map((index) => index - loadedCount))
}

/**
 * Removes staged inserts, carrying the surviving ones' edits with them.
 *
 * Edits are keyed by absolute row index, so dropping a staged row shifts every
 * staged row after it — and their values would land on their neighbours unless
 * the keys move too.
 */
function dropStagedRows(newIndexes: number[]): void {
  const loadedCount = loadedRows.value.length
  const dropped = new Set(newIndexes)
  const survivors = newRows.value
    .map((row, newIndex) => ({ row, newIndex }))
    .filter((entry) => !dropped.has(entry.newIndex))

  const next = reindexStagedEdits(
    { ...edits },
    loadedCount,
    survivors.map((entry) => entry.newIndex)
  )
  for (const key of Object.keys(edits)) delete edits[key]
  Object.assign(edits, next)
  newRows.value = survivors.map((entry) => entry.row)
}

function deleteSelected(rowIndex: number): void {
  deleteRows([rowIndex])
}

/** The values that identify a stored row, taken from its unedited state. */
function keyFor(rowIndex: number): Record<string, CellValue> {
  const row = loadedRows.value[rowIndex]
  const keyColumns = hasPrimaryKey.value
    ? primaryKey.value
    : columns.value.map((column) => column.name)

  const key: Record<string, CellValue> = {}
  for (const name of keyColumns) {
    const index = columns.value.findIndex((column) => column.name === name)
    if (index >= 0) key[name] = row[index] ?? null
  }
  return key
}

function buildChangeSet(): TableChangeSet {
  const updates: TableChangeSet['updates'] = []
  const inserts: TableChangeSet['inserts'] = []

  const byRow = new Map<number, Record<string, CellValue>>()
  for (const [key, value] of Object.entries(edits)) {
    const [rowText, colText] = key.split(':')
    const rowIndex = Number(rowText)
    const column = columns.value[Number(colText)]
    if (!column) continue
    if (!byRow.has(rowIndex)) byRow.set(rowIndex, {})
    byRow.get(rowIndex)![column.name] = value
  }

  for (const [rowIndex, changes] of byRow) {
    if (rowIndex < loadedRows.value.length) {
      if (deletedRows.value.has(rowIndex)) continue
      updates.push({ key: keyFor(rowIndex), changes })
    }
  }

  newRows.value.forEach((_, newIndex) => {
    const rowIndex = loadedRows.value.length + newIndex
    const values = byRow.get(rowIndex) ?? {}
    // Identity and computed columns are server-generated.
    const writable: Record<string, CellValue> = {}
    for (const [name, value] of Object.entries(values)) {
      const column = structure.value?.columns.find((entry) => entry.name === name)
      if (column?.isIdentity || column?.isComputed) continue
      writable[name] = value
    }
    inserts.push({ tempId: `new-${newIndex}`, values: writable })
  })

  return {
    connectionId: props.tab.connectionId,
    schema: props.tab.schema,
    table: props.tab.table,
    inserts,
    updates,
    deletes: [...deletedRows.value].map((rowIndex) => ({ key: keyFor(rowIndex) }))
  }
}

/** Resolves true when the staged changes reached the server. */
async function apply(): Promise<boolean> {
  if (pendingCount.value === 0) return true
  const changeSet = buildChangeSet()

  if (settings.settings.confirmBeforeApply) {
    const summary = [
      changeSet.inserts.length ? `${changeSet.inserts.length} insert` : '',
      changeSet.updates.length ? `${changeSet.updates.length} update` : '',
      changeSet.deletes.length ? `${changeSet.deletes.length} delete` : ''
    ]
      .filter(Boolean)
      .join(', ')
    const warning = hasPrimaryKey.value
      ? ''
      : '\n\nThis table has no primary key, so rows are matched on every column. More than one row may be affected.'
    if (!confirm(`Apply ${summary} to ${props.tab.schema}.${props.tab.table}?${warning}`)) {
      return false
    }
  }

  applying.value = true
  busy.begin()
  try {
    const applied = await api.applyChanges(changeSet)
    toasts.success(
      'Changes applied',
      `${applied.inserted} inserted, ${applied.updated} updated, ${applied.deleted} deleted`
    )
    await load()
    return true
  } catch (error) {
    toasts.fromError('Could not apply the changes — nothing was committed', error)
    return false
  } finally {
    applying.value = false
    busy.end()
  }
}

function goToPage(delta: number): void {
  void withPendingEdits(() => {
    offset.value = Math.max(0, offset.value + delta * pageSize.value)
    return load()
  })
}

/** The formats both "copy as" submenus offer, in one place. */
const COPY_FORMATS: { label: string; format: ExportFormat }[] = [
  { label: 'CSV', format: 'csv' },
  { label: 'TSV', format: 'tsv' },
  { label: 'JSON', format: 'json' },
  { label: 'SQL INSERT', format: 'sql' },
  { label: 'Markdown', format: 'markdown' }
]

const rowMenuItems = computed<MenuEntry[]>(() => {
  const target = menu.value
  const key = target ? foreignKeys.value[target.col] : undefined
  const column = target ? columns.value[target.col] : undefined
  const rows = target ? targetRows(target.row) : []

  // Everything below reads to whoever right-clicked: one row, or the block
  // they picked out.
  const many = rows.length > 1
  const these = many ? `${rows.length} rows` : 'row'
  const isNew = rows.length > 0 && rows.every((index) => index >= loadedRows.value.length)
  const deleted = rows.length > 0 && rows.every((index) => deletedRows.value.has(index))

  return [
    { label: 'Copy cell', action: 'copy-cell', hint: 'Ctrl+C' },
    { label: many ? `Copy ${these}` : 'Copy row', action: 'copy-row', hint: 'Ctrl+Shift+C' },
    {
      label: many ? `Copy ${these} as` : 'Copy row as',
      items: COPY_FORMATS.map(({ label, format }) => ({ label, action: `copy-row-${format}` }))
    },
    {
      label: `Copy all ${allRows.value.length === 1 ? 'row' : 'rows'} as`,
      items: COPY_FORMATS.map(({ label, format }) => ({ label, action: `copy-all-${format}` }))
    },

    { separator: true, label: '' },
    { label: 'Filter by this value', action: 'filter-eq', disabled: !column },
    { label: 'Exclude this value', action: 'filter-ne', disabled: !column },
    {
      label: 'Clear filters',
      action: 'filter-clear',
      disabled: filters.value.length === 0 && !rawWhere.value.trim()
    },

    ...(key
      ? [
          { separator: true, label: '' },
          { label: `Open referenced row in ${key.schema}.${key.table}`, action: 'follow-key' }
        ]
      : []),

    { separator: true, label: '' },
    { label: 'Edit cell', action: 'edit-cell', hint: 'Enter', disabled: !editable.value },
    { label: 'Set to NULL', action: 'null', hint: 'Delete', disabled: !editable.value },
    {
      label: many ? `Undo edits in these ${these}` : 'Undo edits in this row',
      action: 'revert-row',
      disabled: !rowsHaveEdits(rows)
    },

    { separator: true, label: '' },
    { label: many ? `Duplicate ${these}` : 'Duplicate row', action: 'duplicate', disabled: !editable.value },
    { label: 'Add row', action: 'add', disabled: !editable.value },
    {
      // A staged insert is dropped outright; a stored row is marked and can be
      // unmarked, so the label has to say which of the two this is.
      label: isNew
        ? `Remove staged ${these}`
        : deleted
          ? `Undo delete ${these}`
          : `Delete ${these}`,
      action: 'delete',
      hint: 'Ctrl+Delete',
      danger: !deleted,
      disabled: !editable.value
    },

    { separator: true, label: '' },
    { label: 'Select all rows', action: 'select-all', hint: 'Ctrl+A' },
    // Opens the panel on the row that was clicked, whether or not it was
    // already open — which is a different thing from the toggle below it.
    { label: 'View row details', action: 'row-details', hint: 'Ctrl+I' },
    {
      label: showRowPanel.value ? 'Hide row panel' : 'Show row panel',
      action: 'toggle-panel'
    },
    { label: 'Refresh', action: 'refresh', hint: 'F5' },
    { label: 'Export…', action: 'export' }
  ]
})

/** What right-clicking a column header offers: how it is ordered and filtered. */
const headerMenuItems = computed<MenuEntry[]>(() => {
  const column = menu.value ? columns.value[menu.value.col] : undefined
  if (!column) return []
  const sort = sorts.value.find((entry) => entry.column === column.name)
  return columnMenuItems({
    column: column.name,
    direction: sort?.direction ?? null,
    anySort: sorts.value.length > 0,
    // The table browser writes the query, so it can filter as well as sort.
    filterable: true,
    filtered: filters.value.length > 0 || rawWhere.value.trim() !== ''
  })
})

const menuItems = computed<MenuEntry[]>(() =>
  menu.value?.kind === 'header' ? headerMenuItems.value : rowMenuItems.value
)

/** The column half of the menu; `onMenuSelect` hands over when it is open. */
async function onColumnMenuSelect(action: string, columnIndex: number): Promise<void> {
  const column = columns.value[columnIndex]
  if (!column) return

  switch (action) {
    case 'sort-asc':
      sortBy(column.name, 'asc')
      break
    case 'sort-desc':
      sortBy(column.name, 'desc')
      break
    case 'sort-add':
      addSort(column.name)
      break
    case 'sort-clear':
      clearSorts()
      break
    case 'filter-column':
      filterOnColumn(columnIndex)
      break
    case 'filter-null':
      filterNullity(columnIndex, 'is null')
      break
    case 'filter-not-null':
      filterNullity(columnIndex, 'is not null')
      break
    case 'filter-clear':
      clearFilters()
      break
    case 'copy-name':
      await api.copyToClipboard(column.name)
      toasts.info(`Copied “${column.name}”`)
      break
    case 'fit-column':
      grid.value?.autoFit(columnIndex)
      break
    case 'fit-all':
      grid.value?.autoFitAll()
      break
  }
}

async function onMenuSelect(action: string): Promise<void> {
  const target = menu.value
  if (!target) return
  if (target.kind === 'header') return onColumnMenuSelect(action, target.col)

  switch (action) {
    case 'copy-cell':
      await grid.value?.copySelection(false)
      break
    case 'copy-row':
      await grid.value?.copySelection(true)
      break
    case 'follow-key':
      followKey(target.row, target.col)
      break
    case 'null':
      onEdit(target.row, target.col, null)
      break
    case 'add':
      addRow()
      break
    case 'delete':
      deleteRows(targetRows(target.row))
      break
    case 'edit-cell':
      grid.value?.beginEdit(target.row, target.col)
      break
    case 'duplicate':
      duplicateRows(targetRows(target.row))
      break
    case 'revert-row':
      revertRows(targetRows(target.row))
      break
    case 'select-all':
      grid.value?.selectRows(allRows.value.map((_, index) => index))
      break
    case 'filter-eq':
      filterByCell(target.row, target.col, false)
      break
    case 'filter-ne':
      filterByCell(target.row, target.col, true)
      break
    case 'filter-clear':
      clearFilters()
      break
    case 'row-details':
      showRowDetails(target.row, target.col)
      break
    case 'toggle-panel':
      toggleRowPanel()
      break
    case 'refresh':
      void withPendingEdits(() => load())
      break
    case 'export':
      emit('export', columns.value, allRows.value, `${props.tab.schema}.${props.tab.table}`)
      break
    default: {
      // copy-row-<format> and copy-all-<format> differ only in what they copy.
      const copy = /^copy-(row|all)-(.+)$/.exec(action)
      if (copy) {
        await copyAs(copy[2] as ExportFormat, copy[1] === 'row' ? targetRows(target.row) : null)
      }
      break
    }
  }
}

/**
 * Puts rows on the clipboard in one of the export formats.
 *
 * `rowIndexes` picks rows, with their staged edits applied — what is on screen
 * is what gets copied; null takes the whole page.
 */
async function copyAs(format: ExportFormat, rowIndexes: number[] | null): Promise<void> {
  const indexes = rowIndexes ?? allRows.value.map((_, index) => index)
  const rows = indexes.map((index) => mergedRow(index) ?? [])

  const text = exportRows(columns.value, rows, {
    format,
    includeHeader: true,
    tableName: `${props.tab.schema}.${props.tab.table}`
  })
  await api.copyToClipboard(text)
  toasts.info(`Copied ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} as ${format}`)
}

defineExpose({
  refresh: () => withPendingEdits(() => load()),
  focusFilter: () => {
    showFilters.value = true
  },
  exportRows: () =>
    emit('export', columns.value, allRows.value, `${props.tab.schema}.${props.tab.table}`)
})

const structureColumns = computed<TableColumn[]>(() => structure.value?.columns ?? [])
</script>

<template>
  <div class="data">
    <div class="data__toolbar">
      <TableViewSwitch :tab="tab" />

      <span class="data__name mono truncate">
        {{ tab.schema }}.<strong>{{ tab.table }}</strong>
      </span>
      <span v-if="rowCountLabel" class="data__rows mono">{{ rowCountLabel }}</span>

      <div class="data__spacer"></div>

      <button class="btn" :disabled="loading" @click="withPendingEdits(() => load())">
        ⟳ Refresh
      </button>
      <button
        class="btn"
        :class="{ 'btn--armed': showFilters || filters.length > 0 || !!rawWhere }"
        @click="showFilters = !showFilters"
      >
        Filter
        <span v-if="filters.length || rawWhere" class="data__dot"></span>
      </button>
      <button
        class="btn"
        :class="{ 'btn--armed': showRowPanel }"
        :title="`${showRowPanel ? 'Hide' : 'Show'} the selected row beside the grid (Ctrl+I)`"
        :aria-pressed="showRowPanel"
        @click="toggleRowPanel"
      >
        ▤ Row details
      </button>

      <template v-if="editable">
        <div class="divider-v"></div>
        <button class="btn" @click="addRow">+ Row</button>
        <button v-if="pendingCount > 0" class="btn btn--muted" :disabled="applying" @click="discard">
          Discard
        </button>
        <button
          v-if="pendingCount > 0"
          class="btn btn--primary"
          :disabled="applying"
          @click="apply"
        >
          <span v-if="applying" class="spinner"></span>
          Apply
          <span class="seg__count">{{ pendingCount }}</span>
        </button>
      </template>
      <span v-else class="badge">read only</span>
    </div>

    <FilterBuilder
      v-if="showFilters"
      :columns="structureColumns"
      :filters="filters"
      :mode="filterMode"
      :raw-where="rawWhere"
      @update:filters="filters = $event"
      @update:mode="filterMode = $event"
      @update:raw-where="rawWhere = $event"
      @apply="withPendingEdits(() => load(true))"
    />

    <div v-if="warnNoPrimaryKey" class="data__warning">
      This table has no primary key. Edits match rows on every column, so a duplicate row would be
      changed more than once.
    </div>

    <div class="data__grid">
      <SplitPane
        v-model="rowPanelWidth"
        direction="horizontal"
        pane="second"
        :min="220"
        :max="960"
        :collapsed="!showRowPanel"
      >
        <template #first>
          <DataGrid
            ref="grid"
            :columns="columns"
            :rows="allRows"
            :row-states="rowStates"
            :edited-cells="edits"
            :editable="editable"
            :loading="loading"
            :sorts="sorts"
            :row-offset="offset"
            :primary-key="primaryKey"
            :foreign-keys="foreignKeyLabels"
            empty-message="No rows match"
            @edit="onEdit"
            @revert-cell="revertCell"
            @sort="onSort"
            @selection="selection = $event"
            @rows-selected="selectedRows = $event"
            @delete-rows="deleteRows"
            @follow-key="followKey($event.rowIndex, $event.columnIndex)"
            @row-context="
              menu = {
                kind: 'row',
                x: $event.x,
                y: $event.y,
                row: $event.rowIndex,
                col: $event.columnIndex
              }
            "
            @header-context="
              menu = { kind: 'header', x: $event.x, y: $event.y, row: -1, col: $event.columnIndex }
            "
          />
        </template>

        <template #second>
          <RowDetailPanel
            v-if="showRowPanel"
            :fields="rowFields"
            :label="rowLabel"
            :editable="editable"
            :state="rowState"
            :selected-index="selection?.columnIndex ?? null"
            :has-previous="!!selection && selection.rowIndex > 0"
            :has-next="!!selection && selection.rowIndex < allRows.length - 1"
            @edit="editSelectedRow"
            @revert="selection && revertCell(selection.rowIndex, $event)"
            @follow-key="selection && followKey(selection.rowIndex, $event)"
            @select="selection && grid?.selectCell(selection.rowIndex, $event)"
            @move="moveSelection"
            @close="toggleRowPanel"
          />
        </template>
      </SplitPane>
    </div>

    <div class="data__foot">
      <button class="btn btn--sm" :disabled="!canPrevious || loading" @click="goToPage(-1)">
        ‹ Prev
      </button>
      <span class="data__page num">{{ pageRange }} <span class="dim">of</span> {{ pageTotal }}</span>
      <button class="btn btn--sm" :disabled="!canNext || loading" @click="goToPage(1)">
        Next ›
      </button>

      <select
        v-model.number="pageSize"
        class="select select--sm data__pagesize"
        @change="withPendingEdits(() => load(true))"
      >
        <option :value="50">50</option>
        <option :value="100">100</option>
        <option :value="200">200</option>
        <option :value="500">500</option>
        <option :value="1000">1000</option>
      </select>

      <div class="data__spacer"></div>
      <span class="dim mono data__ms">{{ durationMs }} ms</span>
      <div class="divider-v data__foot-rule"></div>
      <span class="dim mono truncate data__sql" :title="lastSql">
        {{ lastSql.replace(/\s+/g, ' ') }}
      </span>
    </div>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @select="onMenuSelect"
      @close="menu = null"
    />

    <!-- Reloading rekeys every staged edit, so this is the last chance to keep them. -->
    <BaseModal
      v-if="pendingPrompt"
      kicker="Unsaved changes"
      title="This table has staged edits"
      :subtitle="`${tab.schema}.${tab.table}`"
      width="480px"
      @close="answerPendingPrompt('cancel')"
    >
      <p class="prompt__text">
        {{ pendingCount }} staged {{ pendingCount === 1 ? 'change has' : 'changes have' }} not been
        written to the database. Reloading the table would discard
        {{ pendingCount === 1 ? 'it' : 'them' }}.
      </p>

      <template #footer>
        <button class="btn" @click="answerPendingPrompt('cancel')">Cancel</button>
        <div class="prompt__spacer"></div>
        <button class="btn btn--danger" @click="answerPendingPrompt('discard')">Discard</button>
        <button class="btn btn--primary" @click="answerPendingPrompt('apply')">
          Apply and continue
        </button>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.prompt__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.prompt__spacer {
  flex: 1;
}

.data {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
/* One command bar: the view switch, what you are looking at, and what you can
   do to it. The Data/Structure strip used to sit above this. */
.data__toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--h-commandbar);
  padding: 0 12px;
  border-bottom: var(--rule) solid var(--border-strong);
  background: var(--bg-surface);
  flex: 0 0 auto;
}
.data__name {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--text-primary);
}
.data__name strong {
  font-weight: 700;
}
.data__rows {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-dim);
}
.data__spacer {
  flex: 1;
}
.data__toolbar .btn {
  flex: 0 0 auto;
}
.data__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  background: var(--accent);
}
.data__warning {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-strong);
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--text-primary);
  font-size: 12px;
}
.data__grid {
  flex: 1;
  min-height: 0;
}
.data__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--h-gridheader);
  padding: 0 12px;
  border-top: var(--rule) solid var(--border-strong);
  background: var(--bg-app);
  font-size: 11px;
  flex: 0 0 auto;
}
.data__page {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.data__pagesize {
  width: auto;
  min-width: 72px;
  padding-right: 24px;
  font-size: 12px;
}
.data__ms {
  flex: 0 0 auto;
  font-size: 11px;
}
.data__foot-rule {
  height: 16px;
}
.data__sql {
  max-width: 44%;
  font-size: 11px;
}
</style>
