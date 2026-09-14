<script setup lang="ts">
/**
 * One table's structure, opened out underneath it in the tree.
 *
 * What the sidebar is for is finding things, and "which column was it called"
 * is most of that — a question the structure tab answers, at the cost of a tab
 * and losing your place in the tree. So the table opens where it stands, into
 * the four folders that say what is in it, each with its count: columns, keys,
 * foreign keys, indexes.
 *
 * The structure behind it is the schema store's, read once and kept, so
 * opening a table a second time costs nothing and the structure tab, the DDL
 * builders and this all read the same answer.
 */
import { computed } from 'vue'
import type { TableColumn, TableIndex } from '@shared/types'
import {
  FOLDER_LABELS,
  STRUCTURE_FOLDERS,
  foreignKeyTarget,
  indexColumnList,
  type StructureFolder,
  type TableKey
} from '../lib/schemaTree'
import { useSchemaStore } from '../stores/schema'

const props = defineProps<{ schema: string; table: string }>()
const emit = defineEmits<{
  (event: 'open-table', schema: string, table: string): void
}>()

const store = useSchemaStore()

const tree = computed(() => store.structureOf(props.schema, props.table))
const state = computed(() => store.structureState(props.schema, props.table))
const error = computed(() => store.structureError(props.schema, props.table))

function isOpen(folder: StructureFolder): boolean {
  return store.isFolderOpen(props.schema, props.table, folder)
}

function toggle(folder: StructureFolder): void {
  store.toggleFolder(props.schema, props.table, folder)
}

function count(folder: StructureFolder): number {
  return tree.value ? tree.value[folder].length : 0
}

/** Everything about a column that will not fit on its line. */
function columnTitle(column: TableColumn): string {
  const parts = [`${column.name} ${column.fullType}`, column.nullable ? 'NULL' : 'NOT NULL']
  if (column.isPrimaryKey) parts.push('primary key')
  if (column.isIdentity) parts.push('identity')
  if (column.isComputed) parts.push('computed')
  if (column.defaultValue) parts.push(`default ${column.defaultValue}`)
  if (column.description) parts.push(column.description)
  return parts.join(' · ')
}

function keyTitle(key: TableKey): string {
  return `${key.kind === 'primary' ? 'Primary key' : 'Unique'} ${key.name} (${key.columns.join(', ')})`
}

function indexTitle(index: TableIndex): string {
  const kind = [
    index.isUnique ? 'unique' : null,
    index.isClustered ? 'clustered' : 'nonclustered',
    index.isDisabled ? 'disabled' : null
  ].filter(Boolean)
  return `${index.name} — ${kind.join(', ')} (${indexColumnList(index)})`
}
</script>

<template>
  <div class="objtree">
    <div v-if="state === 'loading'" class="objtree__note">
      <span class="spinner"></span> Reading structure…
    </div>
    <div v-else-if="state === 'error'" class="objtree__note objtree__note--error" :title="error ?? ''">
      {{ error }}
    </div>

    <template v-else-if="tree">
      <template v-for="folder in STRUCTURE_FOLDERS" :key="folder">
        <button class="folder" @click="toggle(folder)">
          <span class="folder__chevron" :class="{ 'folder__chevron--open': isOpen(folder) }">
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
          <span class="folder__name">{{ FOLDER_LABELS[folder] }}</span>
          <span class="folder__count">{{ count(folder) }}</span>
        </button>

        <template v-if="isOpen(folder)">
          <div v-if="count(folder) === 0" class="leaf leaf--empty">none</div>

          <template v-else-if="folder === 'columns'">
            <div
              v-for="column in tree.columns"
              :key="column.name"
              class="leaf"
              :title="columnTitle(column)"
            >
              <span class="leaf__mark" :class="{ 'leaf__mark--key': column.isPrimaryKey }">
                {{ column.isPrimaryKey ? '◆' : '▪' }}
              </span>
              <span class="leaf__name mono truncate">{{ column.name }}</span>
              <span class="leaf__meta mono truncate">{{ column.fullType }}</span>
            </div>
          </template>

          <template v-else-if="folder === 'keys'">
            <div
              v-for="key in tree.keys"
              :key="key.name"
              class="leaf"
              :title="keyTitle(key)"
            >
              <span class="leaf__mark leaf__mark--key">◆</span>
              <span class="leaf__name mono truncate">{{ key.name }}</span>
              <span class="leaf__meta mono truncate">{{ key.columns.join(', ') }}</span>
            </div>
          </template>

          <!-- A foreign key is a way through to the table it names, so it is
               the one leaf that does something when it is clicked. -->
          <template v-else-if="folder === 'foreignKeys'">
            <button
              v-for="key in tree.foreignKeys"
              :key="key.name"
              class="leaf leaf--link"
              :title="`${key.name}: ${key.columns.join(', ')} → ${foreignKeyTarget(key)}`"
              @click="emit('open-table', key.referencedSchema, key.referencedTable)"
            >
              <span class="leaf__mark">→</span>
              <span class="leaf__name mono truncate">{{ key.columns.join(', ') }}</span>
              <span class="leaf__meta mono truncate">{{ foreignKeyTarget(key) }}</span>
            </button>
          </template>

          <template v-else>
            <div
              v-for="index in tree.indexes"
              :key="index.name"
              class="leaf"
              :title="indexTitle(index)"
            >
              <span class="leaf__mark" :class="{ 'leaf__mark--key': index.isUnique }">≡</span>
              <span class="leaf__name mono truncate">{{ index.name }}</span>
              <span class="leaf__meta mono truncate">{{ indexColumnList(index) }}</span>
            </div>
          </template>
        </template>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* The whole subtree sits under one rule dropped from the table's own row, so
   an opened table reads as a block rather than as more rows in the list. The
   indent puts the folders' twisties under the table's icon. */
.objtree {
  border-left: 1px solid var(--border-subtle);
  margin-left: 22px;
  background: var(--bg-app);
}

.objtree__note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  font-size: 11px;
  color: var(--text-muted);
}
.objtree__note--error {
  color: var(--danger);
}

.folder {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 24px;
  padding: 0 12px 0 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  text-align: left;
  cursor: pointer;
}
.folder:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
/* The same mark as the table's own twisty, a level in: drawn rather than
   typed, and turned a quarter when the folder is open. */
.folder__chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 10px;
  color: var(--text-secondary);
}
.folder__chevron svg {
  width: 9px;
  height: 9px;
  transition: transform var(--transition);
}
.folder__chevron--open svg {
  transform: rotate(90deg);
}
.folder__name {
  flex: 1;
  min-width: 0;
}
.folder__count {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.leaf {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 24px;
  padding: 0 12px 0 24px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
}
.leaf--link {
  cursor: pointer;
}
.leaf--link:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.leaf--empty {
  color: var(--text-dim);
  font-size: 11px;
  font-style: italic;
  padding-left: 32px;
}
.leaf__mark {
  flex: 0 0 auto;
  width: 8px;
  font-size: 9px;
  color: var(--text-muted);
}
/* What identifies a row, marked the way the grid marks it: in the accent. */
.leaf__mark--key {
  color: var(--accent);
}
.leaf__name {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 11px;
}
/* The type, the key's columns, the index's columns — whatever qualifies the
   name, given the rest of the line and given up first when it runs out. */
.leaf__meta {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10px;
  color: var(--text-dim);
  text-align: right;
}
</style>
