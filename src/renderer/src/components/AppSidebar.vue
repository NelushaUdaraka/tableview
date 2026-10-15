<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RoutineObject, SchemaObject } from '@shared/types'
import AppIcon from './AppIcon.vue'
import ContextMenu, { type MenuEntry } from './ContextMenu.vue'
import ObjectStructureTree from './ObjectStructureTree.vue'
import { useConnectionStore } from '../stores/connections'
import { useLibraryStore } from '../stores/library'
import { useSchemaStore } from '../stores/schema'
import { useTabStore } from '../stores/tabs'
import { useToastStore } from '../stores/toasts'
import { api } from '../lib/api'
import type { IconName } from '../lib/icons'

const emit = defineEmits<{
  (event: 'open-table', schema: string, table: string, type: 'table' | 'view'): void
  (event: 'open-structure', schema: string, table: string, type: 'table' | 'view'): void
  (event: 'open-sql', sql: string, title?: string): void
  (event: 'open-routine', schema: string, name: string): void
  (event: 'generate', kind: string, schema: string, table: string): void
}>()

const connections = useConnectionStore()
const schema = useSchemaStore()
const library = useLibraryStore()
const tabs = useTabStore()
const toasts = useToastStore()

type Panel = 'objects' | 'history' | 'saved'
const panel = ref<Panel>('objects')
const filterInput = ref<HTMLInputElement | null>(null)

const menu = ref<{
  x: number
  y: number
  schema: string
  name: string
  type: 'table' | 'view' | 'routine'
} | null>(null)

const connectionId = computed(() => connections.activeId)

watch(panel, (next) => {
  if (next === 'history') void library.loadHistory()
  if (next === 'saved') void library.loadSavedQueries()
})

// Reading the schema is the workspace's job, not this tree's: the editor's
// autocomplete reads the same store, and a window showing one dragged-out tab
// has no tree on screen at all. What is left here is asking for it again.

async function refresh(): Promise<void> {
  if (!connectionId.value) return
  try {
    await schema.loadAll(connectionId.value)
    toasts.info('Schema refreshed')
  } catch (error) {
    toasts.fromError('Could not refresh the schema', error)
  }
}

async function switchDatabase(name: string): Promise<void> {
  if (!connectionId.value) return
  try {
    await api.useDatabase(connectionId.value, name)
    await schema.loadAll(connectionId.value)
  } catch (error) {
    toasts.fromError(`Could not switch to ${name}`, error)
  }
}

const currentDatabase = computed(() => connections.activeStatus?.currentDatabase ?? '')
const connectionState = computed(() => connections.activeStatus?.state ?? 'disconnected')

/** The object the active tab is showing, so the tree can mark it. */
const activeObject = computed(() => {
  const tab = tabs.active
  if (tab?.kind === 'table') return `${tab.schema}.${tab.table}`
  // A routine's definition is the routine, the way a table's tab is the table.
  if (tab?.kind === 'query' && tab.routine) return `${tab.routine.schema}.${tab.routine.name}`
  return ''
})

function isActive(schemaName: string, name: string): boolean {
  return activeObject.value === `${schemaName}.${name}`
}

/**
 * A read-only connection keeps Truncate and Drop on the menu, greyed and
 * saying why, rather than leaving someone to wonder where they went. Writing
 * the statements is still offered: that only opens them in an editor.
 */
const objectMenuItems = computed<MenuEntry[]>(() => {
  const locked = connections.readOnly
  const hint = locked ? 'Read-only' : undefined
  return [
    { label: 'Open data', action: 'data' },
    { label: 'Open structure', action: 'structure' },
    { separator: true, label: '' },
    { label: 'SELECT statement', action: 'select' },
    { label: 'INSERT statement', action: 'insert' },
    { label: 'UPDATE statement', action: 'update' },
    { label: 'DELETE statement', action: 'delete' },
    { label: 'CREATE TABLE script', action: 'ddl' },
    { separator: true, label: '' },
    { label: 'Copy qualified name', action: 'copy-name' },
    { label: 'Pin / unpin', action: 'pin' },
    { separator: true, label: '' },
    { label: 'Truncate table…', action: 'truncate', danger: !locked, disabled: locked, hint },
    { label: 'Drop…', action: 'drop', danger: !locked, disabled: locked, hint }
  ]
})

const routineMenuItems: MenuEntry[] = [
  { label: 'Show definition', action: 'definition' },
  { label: 'EXEC statement', action: 'exec' },
  { label: 'Copy qualified name', action: 'copy-name' }
]

async function onMenuSelect(action: string): Promise<void> {
  const target = menu.value
  if (!target || !connectionId.value) return
  const id = connectionId.value
  const qualified = `[${target.schema}].[${target.name}]`

  try {
    switch (action) {
      case 'data':
        emit('open-table', target.schema, target.name, target.type as 'table' | 'view')
        break
      case 'structure':
        emit('open-structure', target.schema, target.name, target.type as 'table' | 'view')
        break
      case 'copy-name':
        await api.copyToClipboard(qualified)
        toasts.info('Copied')
        break
      case 'pin':
        schema.togglePinned(target.schema, target.name)
        break
      case 'definition':
        // The workspace reads it — or shows the tab that already has it.
        emit('open-routine', target.schema, target.name)
        break
      case 'exec':
        emit('open-sql', `EXEC ${qualified};`, target.name)
        break
      case 'truncate': {
        if (!confirm(`Delete every row from ${qualified}? This cannot be undone.`)) return
        await api.truncateTable(id, target.schema, target.name)
        toasts.success(`Truncated ${qualified}`)
        break
      }
      case 'drop': {
        if (!confirm(`Drop ${qualified}? This cannot be undone.`)) return
        await api.dropObject(id, target.schema, target.name, target.type as 'table' | 'view')
        toasts.success(`Dropped ${qualified}`)
        await schema.loadAll(id)
        break
      }
      default:
        emit('generate', action, target.schema, target.name)
    }
  } catch (error) {
    toasts.fromError('That did not work', error)
  }
}

function openMenu(
  event: MouseEvent,
  schemaName: string,
  name: string,
  type: 'table' | 'view' | 'routine'
): void {
  menu.value = { x: event.clientX, y: event.clientY, schema: schemaName, name, type }
}

/**
 * Opens a table out into its structure, where it stands in the tree.
 *
 * The structure is read the first time and kept, so this is instant from then
 * on — and it is the schema store's copy, the same one the structure tab and
 * the statement builders read.
 */
function expand(object: SchemaObject): void {
  if (!connectionId.value) return
  schema.toggleObject(connectionId.value, object.schema, object.name)
}

function objectIcon(object: SchemaObject): IconName {
  return object.type === 'view' ? 'view' : 'table'
}

function routineIcon(routine: RoutineObject): IconName {
  return routine.type === 'procedure' ? 'procedure' : 'function'
}

function formatCount(value?: number): string {
  if (value === undefined || value === null) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

const pinnedObjects = computed(() =>
  schema.objects.filter((object) => schema.isPinned(object.schema, object.name))
)

function focusFilter(): void {
  panel.value = 'objects'
  filterInput.value?.focus()
  filterInput.value?.select()
}

defineExpose({ focusFilter, refresh })
</script>

<template>
  <aside class="sidebar">
    <!-- Identity lives here as well as in the status bar: the connection names
         itself at the top of the tree it owns. -->
    <div class="sidebar__conn">
      <div class="caps sidebar__conn-kicker">Connection</div>
      <div class="sidebar__conn-name">
        <span class="sidebar__dot" :class="`sidebar__dot--${connectionState}`"></span>
        <span class="truncate">{{ connections.active?.name ?? 'No connection' }}</span>
      </div>
    </div>

    <div class="sidebar__db">
      <div class="sidebar__db-field">
        <AppIcon class="sidebar__db-icon" name="database" :size="14" />
        <div class="sidebar__db-value">
          <span class="mono truncate">{{ currentDatabase || '(no database)' }}</span>
        </div>
        <AppIcon class="sidebar__db-caret" name="chevron-down" :size="14" />
        <!-- The native select carries the behaviour; the block above carries the
             look, so the control keeps its platform dropdown. -->
        <select
          class="sidebar__db-select"
          :value="currentDatabase"
          title="Active database"
          @change="switchDatabase(($event.target as HTMLSelectElement).value)"
        >
          <option v-if="!currentDatabase" value="">(no database)</option>
          <option v-for="db in schema.visibleDatabases" :key="db.name" :value="db.name">
            {{ db.name }}
          </option>
        </select>
      </div>
      <button
        class="sidebar__db-btn"
        :class="{ 'sidebar__db-btn--on': schema.showSystemDatabases }"
        :title="schema.showSystemDatabases ? 'Hide system databases' : 'Show system databases'"
        :aria-pressed="schema.showSystemDatabases"
        @click="schema.showSystemDatabases = !schema.showSystemDatabases"
      >
        <AppIcon :name="schema.showSystemDatabases ? 'eye' : 'eye-off'" :size="15" />
      </button>
      <button class="sidebar__db-btn" title="Refresh (F5)" aria-label="Refresh" @click="refresh">
        <AppIcon name="refresh" :size="15" />
      </button>
    </div>

    <nav class="sidebar__tabs seg">
      <button
        v-for="entry in (['objects', 'history', 'saved'] as Panel[])"
        :key="entry"
        class="sidebar__tab seg__opt"
        :class="{ 'sidebar__tab--active seg__opt--on': panel === entry }"
        :aria-pressed="panel === entry"
        @click="panel = entry"
      >
        {{ entry === 'objects' ? 'Schema' : entry === 'history' ? 'History' : 'Saved' }}
      </button>
    </nav>

    <!-- Schema tree ---------------------------------------------------- -->
    <template v-if="panel === 'objects'">
      <div class="sidebar__filter">
        <div class="search">
          <AppIcon class="search__glyph" name="search" :size="14" />
          <input
            ref="filterInput"
            v-model="schema.filter"
            class="search__input"
            placeholder="Filter tables…"
            spellcheck="false"
          />
          <span class="search__hint">Ctrl F</span>
        </div>
      </div>

      <div class="sidebar__scroll">
        <div v-if="schema.loading" class="sidebar__loading">
          <span class="spinner"></span> Loading schema…
        </div>

        <template v-else>
          <section v-if="pinnedObjects.length" class="group">
            <div class="group__head group__head--pinned">
              <AppIcon class="group__chevron" name="star" :size="12" />
              Pinned
            </div>
            <button
              v-for="object in pinnedObjects"
              :key="`pin-${object.schema}.${object.name}`"
              class="item item--flush"
              :class="{ 'item--active': isActive(object.schema, object.name) }"
              @click="emit('open-table', object.schema, object.name, object.type)"
              @contextmenu.prevent="openMenu($event, object.schema, object.name, object.type)"
            >
              <AppIcon class="item__icon item__icon--pin" name="star" :size="13" />
              <span class="item__name truncate">{{ object.schema }}.{{ object.name }}</span>
            </button>
          </section>

          <section v-for="group in schema.groups" :key="group.schema" class="group">
            <button class="group__head" @click="schema.toggleExpanded(group.schema)">
              <AppIcon
                class="group__chevron"
                :class="{ 'group__chevron--open': schema.expanded[group.schema] !== false }"
                name="chevron-right"
                :size="12"
              />
              <span class="truncate">{{ group.schema }}</span>
              <span class="group__count">
                {{ group.tables.length + group.views.length + group.routines.length }}
              </span>
            </button>

            <template v-if="schema.expanded[group.schema] !== false">
              <template
                v-for="object in [...group.tables, ...group.views]"
                :key="`${object.schema}.${object.name}`"
              >
                <button
                  class="item"
                  :class="{ 'item--active': isActive(object.schema, object.name) }"
                  @click="emit('open-table', object.schema, object.name, object.type)"
                  @contextmenu.prevent="openMenu($event, object.schema, object.name, object.type)"
                >
                  <!-- Inside the row rather than beside it, so the whole line
                       still opens the table: only the twisty itself expands.
                       Drawn rather than typed — a glyph this small is at the
                       mercy of whichever font the platform falls back to. -->
                  <span
                    class="item__chevron"
                    :class="{
                      'item__chevron--open': schema.isObjectExpanded(object.schema, object.name)
                    }"
                    :title="
                      schema.isObjectExpanded(object.schema, object.name)
                        ? 'Hide the structure'
                        : 'Show the structure'
                    "
                    @click.stop="expand(object)"
                  >
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M4 2.4 7.8 6 4 9.6"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </span>
                  <AppIcon
                    class="item__icon"
                    :class="{ 'item__icon--view': object.type === 'view' }"
                    :name="objectIcon(object)"
                    :size="14"
                  />
                  <span class="item__name truncate">{{ object.name }}</span>
                  <span class="item__count">{{ formatCount(object.rowCountEstimate) }}</span>
                </button>

                <ObjectStructureTree
                  v-if="schema.isObjectExpanded(object.schema, object.name)"
                  :schema="object.schema"
                  :table="object.name"
                  @open-table="(s, t) => emit('open-table', s, t, 'table')"
                />
              </template>

              <button
                v-for="routine in group.routines"
                :key="`r-${routine.schema}.${routine.name}`"
                class="item"
                :class="{ 'item--active': isActive(routine.schema, routine.name) }"
                @click="onMenuSelect('definition')"
                @mousedown="menu = { x: 0, y: 0, schema: routine.schema, name: routine.name, type: 'routine' }"
                @contextmenu.prevent="openMenu($event, routine.schema, routine.name, 'routine')"
              >
                <!-- Nothing to open out: a routine is its definition. -->
                <span class="item__chevron item__chevron--blank"></span>
                <AppIcon class="item__icon item__icon--routine" :name="routineIcon(routine)" :size="14" />
                <span class="item__name truncate">{{ routine.name }}</span>
              </button>
            </template>
          </section>

          <div v-if="schema.groups.length === 0" class="sidebar__empty muted">
            {{ schema.filter ? 'Nothing matches that filter' : 'This database has no user objects' }}
          </div>
        </template>
      </div>
    </template>

    <!-- History --------------------------------------------------------- -->
    <template v-else-if="panel === 'history'">
      <div class="sidebar__filter">
        <div class="search">
          <AppIcon class="search__glyph" name="search" :size="14" />
          <input
            v-model="library.historySearch"
            class="search__input"
            placeholder="Search history…"
            spellcheck="false"
            @input="library.loadHistory()"
          />
        </div>
      </div>
      <div class="sidebar__scroll">
        <button
          v-for="entry in library.history"
          :key="entry.id"
          class="history"
          :class="{ 'history--failed': !entry.success }"
          :title="entry.sql"
          @click="emit('open-sql', entry.sql, 'History')"
        >
          <div class="history__sql mono truncate">{{ entry.sql.replace(/\s+/g, ' ').trim() }}</div>
          <div class="history__meta mono">
            <span>{{ new Date(entry.runAt).toLocaleString() }}</span>
            <span class="history__rows">{{ entry.success ? `${entry.rowCount} rows` : 'failed' }}</span>
            <span>{{ entry.durationMs }}ms</span>
          </div>
        </button>
        <div v-if="library.history.length === 0" class="sidebar__empty muted">No history yet</div>
      </div>
      <div class="sidebar__foot">
        <button class="btn btn--muted" @click="library.clearHistory()">Clear history</button>
      </div>
    </template>

    <!-- Saved queries --------------------------------------------------- -->
    <template v-else>
      <div class="sidebar__scroll">
        <div v-for="query in library.savedQueries" :key="query.id" class="saved">
          <button class="saved__open" @click="emit('open-sql', query.sql, query.name)">
            <div class="saved__name truncate">{{ query.name }}</div>
            <div class="saved__sql mono truncate">{{ query.sql.replace(/\s+/g, ' ').trim() }}</div>
          </button>
          <button
            class="saved__del"
            title="Delete"
            aria-label="Delete saved query"
            @click="library.deleteSavedQuery(query.id)"
          >
            <AppIcon name="trash" :size="14" />
          </button>
        </div>
        <div v-if="library.savedQueries.length === 0" class="sidebar__empty muted">
          Save a query with Ctrl+S
        </div>
      </div>
    </template>

    <ContextMenu
      v-if="menu && menu.x > 0"
      :x="menu.x"
      :y="menu.y"
      :items="menu.type === 'routine' ? routineMenuItems : objectMenuItems"
      @select="onMenuSelect"
      @close="menu = null"
    />
  </aside>
</template>

<style scoped>
/* The sidebar is chrome: it shares the frame's ground with the title and
   status bars, and the content beside it sits a step lighter. */
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-app);
}

/* --- connection + database header ---------------------------------------- */
.sidebar__conn {
  padding: 14px 14px 8px;
}
.sidebar__conn-kicker {
  margin-bottom: 4px;
  font-size: 10px;
}
.sidebar__conn-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  min-width: 0;
}
.sidebar__dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--text-muted);
}
.sidebar__dot--connected {
  background: var(--success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 22%, transparent);
}
.sidebar__dot--connecting {
  background: var(--warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 22%, transparent);
}
.sidebar__dot--error {
  background: var(--danger);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 22%, transparent);
}

.sidebar__db {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 10px 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
}
/* Looks like a select, and is one: the real control lies over it. */
.sidebar__db-field {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  height: 30px;
  margin-right: 4px;
  padding: 0 8px 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-control);
  box-shadow: var(--shadow-xs);
  transition:
    border-color var(--transition),
    box-shadow var(--transition);
}
.sidebar__db-field:hover {
  border-color: var(--border-hover);
}
.sidebar__db-field:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.sidebar__db-icon,
.sidebar__db-caret {
  color: var(--text-muted);
}
.sidebar__db-value {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  font-size: 12px;
}
/* Transparent, but still the real control — it takes every click on the block. */
.sidebar__db-select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  opacity: 0;
  cursor: pointer;
}
.sidebar__db-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background-color var(--transition),
    color var(--transition);
}
.sidebar__db-btn:hover {
  background: var(--bg-hover-strong);
  color: var(--text-primary);
}
.sidebar__db-btn--on {
  color: var(--accent-fg);
}

/* --- panel switch ---------------------------------------------------------- */
.sidebar__tabs {
  display: flex;
  margin: 12px 12px 0 14px;
}
.sidebar__tab {
  flex: 1;
}

/* --- filter --------------------------------------------------------------- */
.sidebar__filter {
  padding: 10px 12px 8px 14px;
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 6px 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  transition:
    border-color var(--transition),
    box-shadow var(--transition);
}
.search:hover {
  border-color: var(--border-hover);
}
.search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.search__glyph {
  color: var(--text-muted);
}
.search__input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  user-select: text;
}
.search__input::placeholder {
  color: var(--text-muted);
}
.search__hint {
  flex: 0 0 auto;
  padding: 2px 5px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 500;
  line-height: 1.2;
}

.sidebar__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: 10px;
}
.sidebar__loading,
.sidebar__empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px;
  font-size: 13px;
  color: var(--text-muted);
}
.sidebar__foot {
  padding: 10px 12px;
  border-top: 1px solid var(--border-subtle);
}

/* --- the tree ------------------------------------------------------------- */
/* Schemas are quiet section headings; the objects under them are rounded
   rows that light up under the pointer. */
.group + .group {
  margin-top: 4px;
}
.group__head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  padding: 0 14px 0 12px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  text-align: left;
  transition: color var(--transition);
}
.group__head:hover {
  color: var(--text-primary);
}
.group__head--pinned {
  cursor: default;
}
.group__head--pinned:hover {
  color: var(--text-muted);
}
.group__head--pinned .group__chevron {
  color: var(--key);
}
.group__chevron {
  color: var(--text-dim);
  transition: transform var(--transition);
}
.group__chevron--open {
  transform: rotate(90deg);
}
.group__count {
  margin-left: auto;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: calc(100% - 12px);
  height: 28px;
  margin: 0 6px;
  padding: 0 8px 0 2px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition:
    background-color var(--transition),
    color var(--transition);
}
.item--flush {
  padding-left: 10px;
}
/* The twisty is part of the row, so it takes its own clicks and leaves the
   rest of the line to open the table. It is the full height of the row for the
   same reason a checkbox has a label: a 10px mark is not a target. */
.item__chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  flex: 0 0 auto;
  width: 16px;
  color: var(--text-dim);
}
.item__chevron svg {
  width: 10px;
  height: 10px;
  transition: transform var(--transition);
}
/* Open is the same mark turned a quarter, which is what says it can be shut. */
.item__chevron--open svg {
  transform: rotate(90deg);
}
.item__chevron:hover {
  color: var(--text-primary);
}
/* Holds the column open for rows that have nothing to open out. */
.item__chevron--blank {
  pointer-events: none;
}
.item:hover {
  background: var(--bg-hover-strong);
  color: var(--text-primary);
}
/* The object the active tab is showing. */
.item--active,
.item--active:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}
.item__icon {
  color: var(--text-muted);
}
.item--active .item__icon {
  color: var(--accent-fg);
}
.item__icon--pin {
  color: var(--key);
}
.item__name {
  flex: 1;
  min-width: 0;
}
.item__count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.history {
  display: block;
  width: calc(100% - 12px);
  margin: 0 6px 2px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--transition);
}
.history:hover {
  background: var(--bg-hover-strong);
}
.history__sql {
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-primary);
}
.history__meta {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
}
.history__rows {
  margin-left: auto;
}
.history--failed .history__rows {
  color: var(--danger);
}

.saved {
  display: flex;
  align-items: center;
  margin: 0 6px 2px;
  border-radius: var(--radius-sm);
  transition: background-color var(--transition);
}
.saved:hover {
  background: var(--bg-hover-strong);
}
.saved__open {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}
.saved__name {
  font-size: 13px;
  font-weight: 600;
}
.saved__sql {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 3px;
}
.saved__del {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  margin-right: 4px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity var(--transition),
    background-color var(--transition),
    color var(--transition);
}
.saved:hover .saved__del,
.saved__del:focus-visible {
  opacity: 1;
}
.saved__del:hover {
  background: color-mix(in srgb, var(--danger) 15%, transparent);
  color: var(--danger);
}
</style>
