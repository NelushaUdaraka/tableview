<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { RoutineObject, SchemaObject } from '@shared/types'
import ContextMenu, { type MenuEntry } from './ContextMenu.vue'
import { useConnectionStore } from '../stores/connections'
import { useLibraryStore } from '../stores/library'
import { useSchemaStore } from '../stores/schema'
import { useToastStore } from '../stores/toasts'
import { api } from '../lib/api'

const emit = defineEmits<{
  (event: 'open-table', schema: string, table: string, type: 'table' | 'view'): void
  (event: 'open-structure', schema: string, table: string, type: 'table' | 'view'): void
  (event: 'open-sql', sql: string, title?: string): void
  (event: 'generate', kind: string, schema: string, table: string): void
}>()

const connections = useConnectionStore()
const schema = useSchemaStore()
const library = useLibraryStore()
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

onMounted(() => {
  if (connectionId.value) void schema.loadAll(connectionId.value)
})

watch(connectionId, (id) => {
  schema.reset()
  if (id) void schema.loadAll(id)
})

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

const objectMenuItems: MenuEntry[] = [
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
  { label: 'Truncate table…', action: 'truncate', danger: true },
  { label: 'Drop…', action: 'drop', danger: true }
]

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
      case 'definition': {
        const definition = await api.getObjectDefinition(id, target.schema, target.name)
        emit('open-sql', definition ?? '-- no definition available', target.name)
        break
      }
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

function objectIcon(object: SchemaObject): string {
  return object.type === 'view' ? '◫' : '▤'
}

function routineIcon(routine: RoutineObject): string {
  return routine.type === 'procedure' ? '⚙' : 'ƒ'
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
    <div class="sidebar__db">
      <select
        class="select"
        :value="currentDatabase"
        title="Active database"
        @change="switchDatabase(($event.target as HTMLSelectElement).value)"
      >
        <option v-if="!currentDatabase" value="">(no database)</option>
        <option v-for="db in schema.visibleDatabases" :key="db.name" :value="db.name">
          {{ db.name }}
        </option>
      </select>
      <button
        class="btn btn--ghost btn--icon"
        :title="schema.showSystemDatabases ? 'Hide system databases' : 'Show system databases'"
        @click="schema.showSystemDatabases = !schema.showSystemDatabases"
      >
        {{ schema.showSystemDatabases ? '◉' : '○' }}
      </button>
      <button class="btn btn--ghost btn--icon" title="Refresh (F5)" @click="refresh">⟳</button>
    </div>

    <nav class="sidebar__tabs">
      <button
        v-for="entry in (['objects', 'history', 'saved'] as Panel[])"
        :key="entry"
        class="sidebar__tab"
        :class="{ 'sidebar__tab--active': panel === entry }"
        @click="panel = entry"
      >
        {{ entry === 'objects' ? 'Schema' : entry === 'history' ? 'History' : 'Saved' }}
      </button>
    </nav>

    <!-- Schema tree ---------------------------------------------------- -->
    <template v-if="panel === 'objects'">
      <div class="sidebar__filter">
        <input
          ref="filterInput"
          v-model="schema.filter"
          class="input"
          placeholder="Filter tables… (Ctrl+F)"
          spellcheck="false"
        />
      </div>

      <div class="sidebar__scroll">
        <div v-if="schema.loading" class="sidebar__loading">
          <span class="spinner"></span> Loading schema…
        </div>

        <template v-else>
          <section v-if="pinnedObjects.length" class="group">
            <div class="group__head">Pinned</div>
            <button
              v-for="object in pinnedObjects"
              :key="`pin-${object.schema}.${object.name}`"
              class="item"
              @click="emit('open-table', object.schema, object.name, object.type)"
              @contextmenu.prevent="openMenu($event, object.schema, object.name, object.type)"
            >
              <span class="item__icon item__icon--pin">★</span>
              <span class="item__name truncate">{{ object.schema }}.{{ object.name }}</span>
            </button>
          </section>

          <section v-for="group in schema.groups" :key="group.schema" class="group">
            <button class="group__head" @click="schema.toggleExpanded(group.schema)">
              <span class="group__chevron">{{ schema.expanded[group.schema] === false ? '▸' : '▾' }}</span>
              <span class="truncate">{{ group.schema }}</span>
              <span class="group__count">
                {{ group.tables.length + group.views.length + group.routines.length }}
              </span>
            </button>

            <template v-if="schema.expanded[group.schema] !== false">
              <button
                v-for="object in [...group.tables, ...group.views]"
                :key="`${object.schema}.${object.name}`"
                class="item"
                @click="emit('open-table', object.schema, object.name, object.type)"
                @contextmenu.prevent="openMenu($event, object.schema, object.name, object.type)"
              >
                <span class="item__icon" :class="{ 'item__icon--view': object.type === 'view' }">
                  {{ objectIcon(object) }}
                </span>
                <span class="item__name truncate">{{ object.name }}</span>
                <span class="item__count">{{ formatCount(object.rowCountEstimate) }}</span>
              </button>

              <button
                v-for="routine in group.routines"
                :key="`r-${routine.schema}.${routine.name}`"
                class="item"
                @click="onMenuSelect('definition')"
                @mousedown="menu = { x: 0, y: 0, schema: routine.schema, name: routine.name, type: 'routine' }"
                @contextmenu.prevent="openMenu($event, routine.schema, routine.name, 'routine')"
              >
                <span class="item__icon item__icon--routine">{{ routineIcon(routine) }}</span>
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
        <input
          v-model="library.historySearch"
          class="input"
          placeholder="Search history…"
          spellcheck="false"
          @input="library.loadHistory()"
        />
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
          <div class="history__meta">
            <span>{{ new Date(entry.runAt).toLocaleString() }}</span>
            <span>{{ entry.success ? `${entry.rowCount} rows` : 'failed' }}</span>
            <span>{{ entry.durationMs }}ms</span>
          </div>
        </button>
        <div v-if="library.history.length === 0" class="sidebar__empty muted">No history yet</div>
      </div>
      <div class="sidebar__foot">
        <button class="btn btn--sm btn--ghost" @click="library.clearHistory()">Clear history</button>
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
            class="btn btn--ghost btn--icon btn--sm"
            title="Delete"
            @click="library.deleteSavedQuery(query.id)"
          >
            ✕
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
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-surface);
  border-right: 1px solid var(--border);
}
.sidebar__db {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}
.sidebar__db .select {
  flex: 1;
  min-width: 0;
}
.sidebar__tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
}
.sidebar__tab {
  flex: 1;
  padding: 7px 4px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.sidebar__tab--active {
  color: var(--text-primary);
  border-bottom-color: var(--accent);
}
.sidebar__filter {
  padding: 8px;
}
.sidebar__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: 8px;
}
.sidebar__loading,
.sidebar__empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px;
  font-size: 12px;
  color: var(--text-muted);
}
.sidebar__foot {
  padding: 6px 8px;
  border-top: 1px solid var(--border);
}

.group__head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: pointer;
  text-align: left;
}
.group__head:hover {
  background: var(--bg-hover);
}
.group__chevron {
  width: 10px;
  font-size: 9px;
}
.group__count {
  margin-left: auto;
  font-weight: 500;
  color: var(--text-muted);
}

.item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 3px 8px 3px 22px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.item:hover {
  background: var(--bg-hover);
}
.item__icon {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: 11px;
}
.item__icon--view {
  color: var(--info);
}
.item__icon--routine {
  color: var(--accent);
}
.item__icon--pin {
  color: var(--accent);
}
.item__name {
  flex: 1;
  min-width: 0;
}
.item__count {
  font-size: 10px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.history {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}
.history:hover {
  background: var(--bg-hover);
}
.history--failed .history__sql {
  color: var(--danger);
}
.history__sql {
  font-size: 11px;
}
.history__meta {
  display: flex;
  gap: 8px;
  margin-top: 3px;
  font-size: 10px;
  color: var(--text-muted);
}

.saved {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border);
}
.saved__open {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}
.saved__open:hover {
  background: var(--bg-hover);
}
.saved__name {
  font-size: 12px;
  font-weight: 600;
}
.saved__sql {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 2px;
}
</style>
