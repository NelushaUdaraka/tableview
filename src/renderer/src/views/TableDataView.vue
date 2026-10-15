<script setup lang="ts">
/**
 * Table browser with staged editing.
 *
 * Edits are held locally until "Apply", then sent as one change set that the
 * main process runs inside a transaction. Rows are addressed by their primary
 * key; a table without one falls back to matching on every column, which the
 * banner warns about because it can match more rows than intended.
 */
import {
  computed,
  markRaw,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch
} from 'vue'
import type {
  CellValue,
  ColumnMeta,
  ExportFormat,
  TableChangeSet,
  TableColumn,
  TableDataResponse,
  TableFilter,
  TableSort,
  TableStructure
} from '@shared/types'
import AppIcon from '../components/AppIcon.vue'
import BaseModal from '../components/BaseModal.vue'
import ChoiceMenu from '../components/ChoiceMenu.vue'
import ColumnPicker from '../components/ColumnPicker.vue'
import DataGrid, { type RowState } from '../components/DataGrid.vue'
import FilterBuilder from '../components/FilterBuilder.vue'
import ContextMenu, { type MenuEntry } from '../components/ContextMenu.vue'
import RowDetailPanel, { type RowField } from '../components/RowDetailPanel.vue'
import SplitPane from '../components/SplitPane.vue'
import TableViewSwitch from '../components/TableViewSwitch.vue'
import { exportRows } from '@shared/export'
import { columnMenuItems } from '../lib/columnMenu'
import {
  hiddenColumnIndexes,
  hideColumns,
  pickColumns,
  shownColumnIndexes
} from '../lib/columnVisibility'
import {
  AUTO_REFRESH_CHOICES,
  autoRefreshChoice,
  autoRefreshHold,
  createAutoRefresher,
  type AutoRefreshHold
} from '../lib/autoRefresh'
import { sameColumns, sameRows } from '../lib/tableCache'
import { readsFiltered } from '../lib/tableFilters'
import { reindexStagedEdits } from '../lib/stagedRows'
import { useRowPanel } from '../lib/rowPanel'
import { foreignKeyFilterValue, foreignKeyFilters, foreignKeyTargets } from '@shared/foreignKeys'
import { useBusyStore } from '../stores/busy'
import { useSettingsStore } from '../stores/settings'
import { useSchemaStore } from '../stores/schema'
import { useTabStore } from '../stores/tabs'
import { useToastStore } from '../stores/toasts'
import { useConnectionStore } from '../stores/connections'
import { useCredentialsStore } from '../stores/credentials'
import type { LeaveReason, TableTab } from '../stores/tabs'
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

/**
 * The page this tab had when it was last on screen.
 *
 * Read here in setup, before the first render, which is the whole of what
 * makes coming back to a tab instant: the grid draws the rows the tab already
 * had rather than an empty grid and a spinner. A page read before the tab was
 * handed different filters answers a question nobody is asking any more, so
 * it is not used.
 */
const cached =
  props.tab.cache && props.tab.cache.filterRevision === props.tab.filterRevision
    ? props.tab.cache
    : null

const structure = ref<TableStructure | null>(null)
const columns = shallowRef<ColumnMeta[]>(cached?.columns ?? [])
// shallowRef: the rows array is replaced wholesale, and its contents must not
// be wrapped in reactive proxies (both for speed and because a proxy cannot
// cross the IPC boundary).
const loadedRows = shallowRef<CellValue[][]>(cached?.rows ?? [])
const totalRows = ref<number | null>(cached?.totalRows ?? null)
/**
 * Whether the grid has nothing to show but the wait.
 *
 * True from the start, because mounting this view loads: starting at false
 * drew "No rows match" over the empty grid for as long as the first request
 * took, which is the one moment it is certainly wrong. A tab that has a page
 * cached starts false instead — it has rows, and its re-read happens behind
 * them.
 */
const loading = ref(!cached)
/** A re-read running behind rows that are already on screen. */
const refreshing = ref(false)
/** A re-read the tab's auto-refresh timer asked for, under way. */
const autoReading = ref(false)
/** When the rows on screen were last read, which the auto-refresh control says. */
const lastReadAt = ref<number | null>(null)
const durationMs = ref(cached?.durationMs ?? 0)
const lastSql = ref(cached?.sql ?? '')
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

const offset = ref(cached?.offset ?? 0)
const pageSize = ref(cached?.pageSize ?? settings.settings.pageSize)
const sorts = ref<TableSort[]>(cached?.sorts ?? [])
const filters = ref<TableFilter[]>(cached?.filters ?? [])
const filterMode = ref<'builder' | 'raw'>(cached?.filterMode ?? 'builder')
const rawWhere = ref(cached?.rawWhere ?? '')
const showFilters = ref(cached?.showFilters ?? false)
/**
 * Whether the rows on screen were read through a filter.
 *
 * The builder's rows are only drafts until Apply, so they cannot say this on
 * their own: a filter added and never applied clears without a round trip,
 * while one taken out row by row still leaves the grid filtered until the
 * table is read again.
 */
const readFiltered = ref(cached ? readsFiltered(cached) : false)

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
/**
 * A read-only connection could not apply an edit anyway — the main process
 * refuses it — so nothing is offered that would only fail at Apply.
 */
const editable = computed(() => !isView.value && !connections.readOnly)
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

/** What is about to take the staged edits with it: a reload, or the view going. */
type PendingReason = 'reload' | LeaveReason

/** How the prompt says it, so it is not "reloading" when it is disconnecting. */
const PENDING_CAUSE: Record<PendingReason, string> = {
  reload: 'Reloading the table',
  leave: 'Leaving the table',
  close: 'Closing the table',
  disconnect: 'Disconnecting',
  'close-window': 'Closing the window',
  quit: 'Quitting'
}

/**
 * Asks what to do with staged edits that are about to be lost.
 *
 * Reloading the table replaces the rows the edits are keyed against, so they
 * cannot survive it — but silently dropping them is how a page of retyped
 * values disappears on a stray Refresh. Leaving takes the view, and the edits
 * with it.
 */
const pendingPrompt = ref<{
  reason: PendingReason
  resolve: (choice: PendingChoice) => void
} | null>(null)

function askAboutPendingEdits(reason: PendingReason = 'reload'): Promise<PendingChoice> {
  // A question already on screen — a sort that asked, then the window being
  // closed — is withdrawn rather than left waiting for an answer forever.
  pendingPrompt.value?.resolve('cancel')
  return new Promise((resolve) => {
    pendingPrompt.value = { reason, resolve }
  })
}

function answerPendingPrompt(choice: PendingChoice): void {
  const prompt = pendingPrompt.value
  pendingPrompt.value = null
  prompt?.resolve(choice)
}

/** Runs `action` once the staged edits have been applied or dropped. */
async function withPendingEdits(action: () => unknown): Promise<void> {
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

/**
 * The tab store asks this before this table's view goes: another tab picked,
 * the tab closed, the connection closed, the window closed.
 */
async function confirmLeave(reason: LeaveReason): Promise<boolean> {
  if (pendingCount.value === 0) return true
  const choice = await askAboutPendingEdits(reason)
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
 * Puts a response on screen, replacing only what actually differs.
 *
 * Handing the grid a new `columns` array resets it — its widths, its
 * selection, the row in the panel — and a new `rows` array loses the scroll
 * position, so a read that came back with the page it already had must leave
 * both alone. That is what makes the re-read behind a reselected tab
 * invisible when nothing has changed, and why this compares rather than
 * assigns.
 */
function accept(response: TableDataResponse): void {
  const columnsChanged = !sameColumns(response.columns, columns.value)
  if (columnsChanged) columns.value = response.columns
  // Rows are positional, so a new shape means new rows whatever they hold.
  if (columnsChanged || !sameRows(response.rows, loadedRows.value)) {
    loadedRows.value = response.rows
  }
  totalRows.value = response.totalRows
  durationMs.value = response.durationMs
  lastSql.value = response.sql
}

/** Keeps this page on the tab, for the next time the tab is picked. */
function remember(): void {
  tabs.update<TableTab>(props.tab.id, {
    cache: markRaw({
      columns: columns.value,
      rows: loadedRows.value,
      totalRows: totalRows.value,
      offset: offset.value,
      pageSize: pageSize.value,
      // Copied out of the live refs: nothing should be able to edit a page
      // that has already been put away.
      sorts: sorts.value.map((sort) => ({ ...sort })),
      filters: filters.value.map((filter) => ({ ...filter })),
      filterMode: filterMode.value,
      rawWhere: rawWhere.value,
      showFilters: showFilters.value,
      durationMs: durationMs.value,
      sql: lastSql.value,
      scrollTop: grid.value?.scrollOffset() ?? 0,
      filterRevision: props.tab.filterRevision
    })
  })
}

/**
 * Writes down what the page picked up after it was read: where the reader
 * scrolled to, and whether the filter bar is open.
 *
 * Everything else in the cache describes the rows and is written with them.
 * Paging or sorting and then leaving before the answer arrives must not put
 * the new question away beside the old rows — and a tab with no page cached
 * at all is one whose first read has not landed, which is a spinner when it
 * comes back, not an empty grid.
 */
function rememberView(): void {
  const cache = props.tab.cache
  if (!cache) return
  const scrollTop = grid.value?.scrollOffset() ?? 0
  if (cache.scrollTop === scrollTop && cache.showFilters === showFilters.value) return
  tabs.update<TableTab>(props.tab.id, {
    cache: markRaw({ ...cache, scrollTop, showFilters: showFilters.value })
  })
}

/**
 * Whichever load was asked for last is the one whose answer counts.
 *
 * A tab that comes back on screen re-reads its page in the background, and
 * that read is still in flight when the reader sorts, filters or pages — its
 * answer would otherwise land on top of theirs.
 */
let loadToken = 0

/**
 * Fetches the current page.
 *
 * The rows already on screen are left alone until the new ones arrive: the
 * grid dims them and stops answering, and the window's progress bar carries
 * the wait. Sorting a table no longer empties it for the round trip.
 *
 * `background` is the re-read a tab does when it is picked again. Those rows
 * are what the reader was looking at a moment ago, so nothing is dimmed and
 * nothing is blocked; the answer reaches the grid only where it differs from
 * what is already drawn.
 *
 * `auto` is a background read the tab's timer asked for. Nobody is waiting on
 * it, so it stays off the window's progress bar and out of the "Checking for
 * changes" note — the auto-refresh control shows it instead, rather than
 * something blinking in the toolbar every few seconds.
 *
 * Resolves false only when the read failed; one overtaken by a newer read has
 * not.
 */
async function load(resetOffset = false, background = false, auto = false): Promise<boolean> {
  if (resetOffset) offset.value = 0
  const token = ++loadToken
  if (background) refreshing.value = true
  else loading.value = true
  autoReading.value = auto
  if (!auto) busy.begin()
  // Taken now: the filter bar can be edited while the read is out.
  const filtered = readsFiltered({
    filters: filters.value,
    filterMode: filterMode.value,
    rawWhere: rawWhere.value
  })
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
    if (token !== loadToken) return true
    // A background re-read never pulls rows out from under staged edits: they
    // are keyed by row index, and the reader is in the middle of typing them.
    // The page on screen stays the page, and Refresh still says otherwise.
    if (background && pendingCount.value > 0) return true
    accept(response)
    readFiltered.value = filtered
    if (!background) discard()
    remember()
    lastReadAt.value = Date.now()
    return true
  } catch (error) {
    if (token !== loadToken) return true
    // A session that ran out mid-browse is fixable in place; retry this load.
    const connection = connections.saved.find((entry) => entry.id === props.tab.connectionId)
    const retry = async (): Promise<void> => {
      await load(resetOffset, background)
    }
    if (!credentials.offerRefresh(connection, error, retry)) {
      toasts.fromError(
        auto ? 'Auto refresh stopped: the table could not be read' : 'Could not load the table',
        error
      )
    }
    return false
  } finally {
    if (!auto) busy.end()
    // Only the newest load may put the indicators down; an overtaken one
    // finishing later would clear the wait its successor is still in.
    if (token === loadToken) {
      loading.value = false
      refreshing.value = false
      autoReading.value = false
    }
  }
}

onBeforeUnmount(() => {
  // The tab is about to be taken down: this is the last chance to write down
  // where it had got to.
  rememberView()
  tabs.setLeaveGuard(props.tab.id, null)
  // A dialog left waiting would keep its caller pending forever.
  if (pendingPrompt.value) answerPendingPrompt('cancel')
  // The interval stays on the tab; the timer goes with the view, and the
  // next view of this tab starts its own.
  autoRefresher.dispose()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

// --- auto refresh -------------------------------------------------------------

const rowPanel = ref<InstanceType<typeof RowDetailPanel> | null>(null)

/** How often this tab re-reads itself; 0 when it does not. */
const autoRefresh = computed(() => props.tab.autoRefresh ?? 0)

const connected = computed(
  () => connections.statusFor(props.tab.connectionId).state === 'connected'
)

/** What stands in the way of a read that has fallen due, if anything does. */
function autoHold(): AutoRefreshHold | null {
  return autoRefreshHold({
    connected: connected.value,
    stagedEdits: pendingCount.value,
    editing: Boolean(grid.value?.isEditing() || rowPanel.value?.hasUncommittedEdit()),
    busy:
      loading.value ||
      refreshing.value ||
      applying.value ||
      pendingPrompt.value !== null ||
      menu.value !== null,
    hidden: document.visibilityState === 'hidden'
  })
}

const autoRefresher = createAutoRefresher({
  hold: () => autoHold() !== null,
  refresh: () => load(false, true, true),
  // It has stopped itself; the tab stops saying it is on.
  onFailure: () => tabs.update<TableTab>(props.tab.id, { autoRefresh: 0 })
})

watch(autoRefresh, (ms) => autoRefresher.set(ms), { immediate: true })

/** The intervals as the toolbar's menu lists them. */
const AUTO_REFRESH_MENU = AUTO_REFRESH_CHOICES.map((choice) => ({
  value: choice.ms,
  label: choice.label
}))

const autoButton = ref<HTMLButtonElement | null>(null)
const autoMenuOpen = ref(false)

/** Picked in the toolbar. Turning it on reads straight away, so it starts out current. */
function chooseAutoRefresh(ms: number): void {
  tabs.update<TableTab>(props.tab.id, { autoRefresh: ms })
  autoRefresher.set(ms, true)
}

/** A window brought back into view catches up rather than waiting out the interval. */
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') autoRefresher.now()
}
document.addEventListener('visibilitychange', onVisibilityChange)

/**
 * The holds worth saying out loud: the ones that last until the reader does
 * something about them. The others pass in a moment.
 */
const autoPaused = computed<string | null>(() => {
  if (autoRefresh.value === 0) return null
  if (!connected.value) return 'Paused while the connection is down'
  if (pendingCount.value > 0) return 'Paused while edits are staged — apply or discard them to carry on'
  return null
})

const autoTitle = computed(() => {
  if (autoRefresh.value === 0) return 'Refresh this table automatically'
  const lines = [`Re-reads the rows ${autoRefreshChoice(autoRefresh.value).label.toLowerCase()}`]
  if (autoPaused.value) lines.push(autoPaused.value)
  if (lastReadAt.value !== null) {
    lines.push(`Last read at ${new Date(lastReadAt.value).toLocaleTimeString()}`)
  }
  return lines.join('\n')
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
  // the store asks here first. Keyed by tab: a split workspace has a view
  // mounted per pane, each answering for its own tab.
  tabs.setLeaveGuard(props.tab.id, confirmLeave)

  if (cached) {
    // The rows are drawn already, and the sort and filters that produced them
    // came back with them. Put the grid where the reader left it, then go and
    // find out whether any of it is still true.
    grid.value?.scrollTo(cached.scrollTop)
    await loadStructure()
    await load(false, true)
    return
  }

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

// --- the columns on show -------------------------------------------------------

/**
 * Columns taken out of the grid, by name. The tab keeps them, as it keeps its
 * interval: they outlast a trip to another tab, a reload and the table's
 * structure, and go with the tab into a window of its own.
 */
const hiddenColumns = computed(() => props.tab.hiddenColumns ?? [])
/** The same columns as positions in the page, which is what the grid takes. */
const hiddenIndexes = computed(() => hiddenColumnIndexes(columns.value, hiddenColumns.value))
/**
 * Positions of the columns on show, in order. Whatever reads the page as the
 * grid shows it — the row panel, a copy, an export — goes through these.
 */
const shownIndexes = computed(() => shownColumnIndexes(columns.value, hiddenColumns.value))

const columnsButton = ref<HTMLButtonElement | null>(null)
const columnsOpen = ref(false)

function setHiddenColumns(names: string[]): void {
  tabs.update<TableTab>(props.tab.id, { hiddenColumns: names.length > 0 ? names : undefined })
}

/** The header menu's "Hide this column". */
function hideColumn(columnIndex: number): void {
  const column = columns.value[columnIndex]
  if (column) setHiddenColumns(hideColumns(hiddenColumns.value, [column.name]))
}

const columnsTitle = computed(() =>
  hiddenIndexes.value.length === 0
    ? 'Choose which columns the grid shows'
    : `${shownIndexes.value.length} of ${columns.value.length} columns shown — choose which`
)

// --- the selected row -------------------------------------------------------

/** The row panel answers to this tab, not to the window. */
const showRowPanel = useRowPanel(() => props.tab)
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
  showRowPanel.value = !showRowPanel.value
}

/**
 * Puts one row in the panel, opening the panel if it was closed.
 *
 * The menu entry that leads here names a row, so it has to select that row as
 * well as show the panel — the panel only ever shows the selected one.
 */
function showRowDetails(rowIndex: number, columnIndex: number): void {
  grid.value?.selectCell(rowIndex, columnIndex)
  showRowPanel.value = true
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

/**
 * The selected row, a field per column on show: a column taken out of the grid
 * is out of the panel beside it too. The panel numbers its fields by position,
 * so `shownIndexes` is how its answers get back to a column.
 */
const rowFields = computed<RowField[]>(() => {
  const current = selection.value
  if (!current) return []
  const row = allRows.value[current.rowIndex]
  if (!row) return []

  return shownIndexes.value.map((index) => {
    const column = columns.value[index]
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

/** The selected column as a position in the panel's list of fields. */
const panelSelectedField = computed(() => {
  const columnIndex = selection.value?.columnIndex
  if (columnIndex === undefined) return null
  const position = shownIndexes.value.indexOf(columnIndex)
  return position < 0 ? null : position
})

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
    toasts.info(isView.value ? 'Views cannot be edited' : 'This connection is read-only')
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
  filters.value = [
    ...filters.value,
    { column: column.name, operator: '=', value: '', conjunction: 'AND' }
  ]
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

/** Something written in the filter bar, or rows on screen that went through a filter. */
const canClearFilters = computed(
  () => readFiltered.value || filters.value.length > 0 || rawWhere.value !== ''
)

/**
 * Takes every filter away — the builder's rows and the raw WHERE together —
 * and reads the table again when the rows on screen went through one. Filters
 * that were only drafted have nothing on screen to undo, so they go without a
 * round trip, and without asking about staged edits a read would have cost.
 */
function clearFilters(): void {
  if (!readFiltered.value) {
    filters.value = []
    rawWhere.value = ''
    return
  }
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
    { label: 'Clear filters', action: 'filter-clear', disabled: !canClearFilters.value },

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
    // already open — which is a different thing from the toggle below it, and
    // from Ctrl+I, so it does not borrow that shortcut's name.
    { label: 'View row details', action: 'row-details' },
    {
      label: showRowPanel.value ? 'Hide row panel' : 'Show row panel',
      action: 'toggle-panel',
      hint: 'Ctrl+I'
    },
    { label: 'Refresh', action: 'refresh', hint: 'F5' },
    { label: 'Export…', action: 'export' }
  ]
})

/** What right-clicking a column header offers: how it is ordered, filtered and shown. */
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
    filtered: canClearFilters.value,
    hideable: true,
    anyHidden: hiddenIndexes.value.length > 0
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
    case 'hide-column':
      hideColumn(columnIndex)
      break
    case 'show-all-columns':
      setHiddenColumns([])
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
      exportPage()
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

/** Rows cut down to the columns on show — the page as the grid draws it. */
function shownPage(rows: CellValue[][]): { columns: ColumnMeta[]; rows: CellValue[][] } {
  return pickColumns(columns.value, rows, shownIndexes.value)
}

/** Hands the page to the export dialog, in the columns the grid is showing. */
function exportPage(): void {
  const page = shownPage(allRows.value)
  emit('export', page.columns, page.rows, `${props.tab.schema}.${props.tab.table}`)
}

/**
 * Puts rows on the clipboard in one of the export formats.
 *
 * `rowIndexes` picks rows, with their staged edits applied — what is on screen
 * is what gets copied, hidden columns left out; null takes the whole page.
 */
async function copyAs(format: ExportFormat, rowIndexes: number[] | null): Promise<void> {
  const indexes = rowIndexes ?? allRows.value.map((_, index) => index)
  const page = shownPage(indexes.map((index) => mergedRow(index) ?? []))

  const text = exportRows(page.columns, page.rows, {
    format,
    includeHeader: true,
    tableName: `${props.tab.schema}.${props.tab.table}`
  })
  await api.copyToClipboard(text)
  const count = page.rows.length
  toasts.info(`Copied ${count} ${count === 1 ? 'row' : 'rows'} as ${format}`)
}

defineExpose({
  refresh: () => withPendingEdits(() => load()),
  toggleRowPanel,
  focusFilter: () => {
    showFilters.value = true
  },
  exportRows: exportPage
})

const structureColumns = computed<TableColumn[]>(() => structure.value?.columns ?? [])
</script>

<template>
  <div class="data" :class="{ 'data--staged': pendingCount > 0 }">
    <div class="data__toolbar">
      <TableViewSwitch :tab="tab" />

      <span class="data__name mono truncate">
        {{ tab.schema }}.<strong>{{ tab.table }}</strong>
      </span>
      <span v-if="rowCountLabel" class="data__rows">{{ rowCountLabel }}</span>
      <!-- A tab picked again re-reads the page it already had. Nothing on
           screen changes while it does, so this is the only thing that says
           the rows are a moment old and being checked. -->
      <span v-if="refreshing && !autoReading" class="data__refreshing">
        <span class="spinner"></span>
        Checking for changes…
      </span>

      <div class="data__spacer"></div>

      <!-- In a narrow pane the secondary buttons give up their words (see
           .data__label), so each carries its name and a tooltip as well. -->
      <button
        class="btn data__tool"
        :disabled="loading"
        title="Refresh (F5)"
        aria-label="Refresh"
        @click="withPendingEdits(() => load())"
      >
        <AppIcon name="refresh" :size="14" />
        <span class="data__label">Refresh</span>
      </button>
      <!-- Says what is chosen and opens the list of the rest. The square is
           the timer: lit while it is on, pulsing while it reads, grey while
           something holds it. -->
      <button
        ref="autoButton"
        class="btn data__tool data__auto"
        :class="{ 'btn--armed': autoRefresh > 0, 'data__auto--paused': !!autoPaused }"
        :title="autoMenuOpen ? undefined : autoTitle"
        :aria-label="`Refresh automatically: ${autoRefreshChoice(autoRefresh).label}`"
        aria-haspopup="menu"
        :aria-expanded="autoMenuOpen"
        :data-interval="autoRefresh"
        @click="autoMenuOpen = !autoMenuOpen"
      >
        <span
          v-if="autoRefresh > 0"
          class="data__auto-dot"
          :class="{ 'data__auto-dot--reading': autoReading }"
        ></span>
        <AppIcon v-else name="clock" :size="14" />
        <span class="data__label">Auto</span>
        <span class="data__auto-value">{{ autoRefreshChoice(autoRefresh).short }}</span>
        <AppIcon class="data__auto-caret" name="chevron-down" :size="12" />
      </button>
      <ChoiceMenu
        v-if="autoMenuOpen"
        :anchor="autoButton"
        label="Refresh automatically"
        :choices="AUTO_REFRESH_MENU"
        :value="autoRefresh"
        @choose="chooseAutoRefresh"
        @close="autoMenuOpen = false"
      />
      <button
        class="btn data__tool"
        :class="{ 'btn--armed': showFilters || filters.length > 0 || !!rawWhere }"
        title="Filter the rows"
        aria-label="Filter"
        @click="showFilters = !showFilters"
      >
        <AppIcon name="filter" :size="14" />
        <span class="data__label">Filter</span>
        <span v-if="filters.length || rawWhere" class="data__dot"></span>
      </button>
      <!-- Hiding a column asks the server nothing: the page is already read
           whole, so the picker changes the grid the moment a box is ticked. -->
      <button
        ref="columnsButton"
        class="btn data__tool data__columns"
        :class="{ 'btn--armed': hiddenIndexes.length > 0 }"
        :disabled="columns.length === 0"
        :title="columnsOpen ? undefined : columnsTitle"
        :aria-label="columnsTitle"
        aria-haspopup="dialog"
        :aria-expanded="columnsOpen"
        @click="columnsOpen = !columnsOpen"
      >
        <AppIcon name="columns" :size="14" />
        <span class="data__label">Columns</span>
        <span v-if="hiddenIndexes.length > 0" class="data__columns-count">
          {{ shownIndexes.length }}/{{ columns.length }}
        </span>
      </button>
      <ColumnPicker
        v-if="columnsOpen"
        :anchor="columnsButton"
        :columns="columns"
        :hidden="hiddenColumns"
        :primary-key="primaryKey"
        @update:hidden="setHiddenColumns"
        @close="columnsOpen = false"
      />
      <button
        class="btn data__tool"
        :class="{ 'btn--armed': showRowPanel }"
        :title="`${showRowPanel ? 'Hide' : 'Show'} the selected row beside the grid (Ctrl+I)`"
        aria-label="Row details"
        :aria-pressed="showRowPanel"
        @click="toggleRowPanel"
      >
        <AppIcon name="panel-right" :size="14" />
        <span class="data__label">Row details</span>
      </button>

      <template v-if="editable">
        <div class="divider-v"></div>
        <button class="btn data__tool" title="Add row" aria-label="Add row" @click="addRow">
          <AppIcon name="plus" :size="14" />
          <span class="data__label">Add row</span>
        </button>
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
      <template v-else-if="connections.readOnly">
        <!-- Edits staged before read-only went on cannot be applied now, but
             they can still be let go of. -->
        <button v-if="pendingCount > 0" class="btn btn--muted" @click="discard">Discard</button>
        <span
          class="badge data__readonly"
          title="This connection is read-only, so its tables cannot be edited"
        >
          <AppIcon name="lock" :size="11" />
          Read-only
        </span>
      </template>
      <span v-else class="badge">read only</span>
    </div>

    <FilterBuilder
      v-if="showFilters"
      :columns="structureColumns"
      :filters="filters"
      :mode="filterMode"
      :raw-where="rawWhere"
      :can-clear="canClearFilters"
      @update:filters="filters = $event"
      @update:mode="filterMode = $event"
      @update:raw-where="rawWhere = $event"
      @apply="withPendingEdits(() => load(true))"
      @clear="clearFilters"
    />

    <div v-if="warnNoPrimaryKey" class="data__warning">
      <AppIcon name="triangle-alert" :size="14" />
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
            :hidden-columns="hiddenIndexes"
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
          >
            <template #no-columns>
              <p>The rows are still here. Pick the columns to show under Columns.</p>
              <button class="btn btn--primary" @click="setHiddenColumns([])">
                Show all columns
              </button>
            </template>
          </DataGrid>
        </template>

        <template #second>
          <RowDetailPanel
            v-if="showRowPanel"
            ref="rowPanel"
            :fields="rowFields"
            :label="rowLabel"
            :editable="editable"
            :state="rowState"
            :selected-index="panelSelectedField"
            :has-previous="!!selection && selection.rowIndex > 0"
            :has-next="!!selection && selection.rowIndex < allRows.length - 1"
            @edit="(field, value) => editSelectedRow(shownIndexes[field], value)"
            @revert="selection && revertCell(selection.rowIndex, shownIndexes[$event])"
            @follow-key="selection && followKey(selection.rowIndex, shownIndexes[$event])"
            @select="selection && grid?.selectCell(selection.rowIndex, shownIndexes[$event])"
            @move="moveSelection"
            @close="toggleRowPanel"
          />
        </template>
      </SplitPane>
    </div>

    <div class="data__foot">
      <div class="data__pager">
        <button
          class="btn btn--sm btn--icon"
          title="Previous page"
          aria-label="Previous page"
          :disabled="!canPrevious || loading"
          @click="goToPage(-1)"
        >
          <AppIcon name="chevron-left" :size="14" />
        </button>
        <span class="data__page num">{{ pageRange }} <span class="dim">of</span> {{ pageTotal }}</span>
        <button
          class="btn btn--sm btn--icon"
          title="Next page"
          aria-label="Next page"
          :disabled="!canNext || loading"
          @click="goToPage(1)"
        >
          <AppIcon name="chevron-right" :size="14" />
        </button>
      </div>

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
      <span class="data__ms">{{ durationMs }} ms</span>
      <div class="divider-v data__foot-rule"></div>
      <span class="mono truncate data__sql" :title="lastSql">
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

    <!-- Reloading rekeys every staged edit, and leaving drops them: this is
         the last chance to keep them. -->
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
        written to the database. {{ PENDING_CAUSE[pendingPrompt.reason] }} would discard
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
  /* The bar answers to the pane's width, not the window's: a split halves it. */
  container: data / inline-size;
}
/* One command bar: the view switch, what you are looking at, and what you can
   do to it. */
.data__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--h-commandbar);
  padding: 0 10px 0 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  flex: 0 0 auto;
}
.data__name {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: 6px;
  font-size: 13px;
  color: var(--text-muted);
}
.data__name strong {
  font-weight: 600;
  color: var(--text-primary);
}
.data__rows {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-primary) 7%, transparent);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.data__refreshing {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-muted);
}
.data__spacer {
  flex: 1;
}
.data__toolbar .btn {
  flex: 0 0 auto;
}
/* A narrow pane — a split, a small window — keeps every control on the bar by
   taking the words off the secondary buttons; their icons, tooltips and names
   stay. */
@container data (max-width: 960px) {
  .data__label {
    display: none;
  }
  .data__tool {
    padding: 0 7px;
  }
}
/* Staged edits bring Discard and Apply, so they need the room sooner: first
   the row count goes — the footer's pager says it too — and then the words. */
@container data (max-width: 1170px) {
  .data--staged .data__rows {
    display: none;
  }
}
@container data (max-width: 1110px) {
  .data--staged .data__label {
    display: none;
  }
  .data--staged .data__tool {
    padding: 0 7px;
  }
}
.data__auto {
  color: var(--text-secondary);
}
.data__auto.btn--armed {
  color: var(--text-primary);
}
.data__auto-value {
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.data__auto-caret {
  margin-right: -2px;
}
/* The timer, lit while it runs and pulsing while it reads. */
.data__auto-dot {
  width: 7px;
  height: 7px;
  margin: 0 2px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.data__auto-dot--reading {
  animation: data-auto-read 520ms ease-in-out infinite alternate;
}
.data__auto--paused .data__auto-dot {
  background: var(--text-muted);
  box-shadow: none;
}
@keyframes data-auto-read {
  to {
    opacity: 0.25;
  }
}
/* How many of the table's columns are on show, once any is not. */
.data__columns-count {
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.data__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.data__readonly {
  gap: 4px;
}
.data__warning {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  background: color-mix(in srgb, var(--warning) 11%, var(--bg-surface));
  color: var(--text-primary);
  font-size: 12px;
}
.data__warning .icon {
  color: var(--warning);
}
.data__grid {
  flex: 1;
  min-height: 0;
}
.data__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--h-gridheader);
  padding: 0 12px 0 8px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-app);
  font-size: 12px;
  flex: 0 0 auto;
}
.data__pager {
  display: flex;
  align-items: center;
  gap: 2px;
}
.data__pager .btn {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}
.data__pager .btn:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}
.data__page {
  min-width: 64px;
  padding: 0 4px;
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
  white-space: nowrap;
}
.data__pagesize {
  width: auto;
  min-width: 76px;
  height: 26px;
  padding-right: 26px;
  font-size: 12px;
  background-position: right 6px center;
}
.data__ms {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.data__foot-rule {
  height: 14px;
}
.data__sql {
  max-width: 44%;
  font-size: 11px;
  color: var(--text-muted);
}
</style>
