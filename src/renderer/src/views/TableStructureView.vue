<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TableForeignKey, TableStructure } from '@shared/types'
import { buildCreateTableDdl } from '@shared/sql/builder'
import AppIcon from '../components/AppIcon.vue'
import TableViewSwitch from '../components/TableViewSwitch.vue'
import { useSchemaStore } from '../stores/schema'
import { useTabStore, type TableTab } from '../stores/tabs'
import { useToastStore } from '../stores/toasts'
import { api } from '../lib/api'

const props = defineProps<{ tab: TableTab }>()
const emit = defineEmits<{ (event: 'open-sql', sql: string, title: string): void }>()

const schemaStore = useSchemaStore()
const tabs = useTabStore()
const toasts = useToastStore()

const structure = ref<TableStructure | null>(null)
const inbound = ref<TableForeignKey[]>([])
const definition = ref<string | null>(null)
const loading = ref(true)
const scroller = ref<HTMLElement | null>(null)
/** How far the structure was scrolled when the tab was last on screen. */
const scrolled = props.tab.structureScroll

onMounted(async () => {
  try {
    structure.value = await schemaStore.getStructure(
      props.tab.connectionId,
      props.tab.schema,
      props.tab.table,
      true
    )
    if (props.tab.objectType === 'view') {
      definition.value = await api.getObjectDefinition(
        props.tab.connectionId,
        props.tab.schema,
        props.tab.table
      )
    } else {
      inbound.value = await api.getInboundForeignKeys(
        props.tab.connectionId,
        props.tab.schema,
        props.tab.table
      )
    }
  } catch (error) {
    toasts.fromError('Could not read the structure', error)
  } finally {
    loading.value = false
  }
  // Drawn once it is read: then the reader can be put back where they were.
  if (!scrolled) return
  await nextTick()
  if (scroller.value) {
    scroller.value.scrollTop = scrolled.top
    scroller.value.scrollLeft = scrolled.left
  }
})

// Picking another tab, or the rows, takes this view down; how far it was
// scrolled stays on the tab.
onBeforeUnmount(() => {
  const element = scroller.value
  if (!element) return
  tabs.update<TableTab>(props.tab.id, {
    structureScroll: { top: element.scrollTop, left: element.scrollLeft }
  })
})

const ddl = computed(() => (structure.value ? buildCreateTableDdl(structure.value) : ''))

async function copyDdl(): Promise<void> {
  await api.copyToClipboard(ddl.value)
  toasts.info('DDL copied')
}

function openDdl(): void {
  emit('open-sql', ddl.value, `${props.tab.table} DDL`)
}

function nullLabel(value: string | null): string {
  return value ?? '—'
}
</script>

<template>
  <div class="structure">
    <div v-if="loading" class="empty-state">
      <span class="spinner"></span>
      <div class="empty-state__title">Reading structure…</div>
    </div>

    <template v-else-if="structure">
      <div class="structure__toolbar">
        <TableViewSwitch :tab="tab" />
        <span class="structure__title mono truncate">
          {{ structure.schema }}.<strong>{{ structure.name }}</strong>
        </span>
        <span class="badge">{{ structure.type }}</span>
        <span v-if="structure.rowCountEstimate !== null" class="structure__rows">
          ~{{ structure.rowCountEstimate.toLocaleString() }} rows
        </span>
        <div class="structure__spacer"></div>
        <button class="btn btn--muted" @click="copyDdl">
          <AppIcon name="copy" :size="14" />
          Copy DDL
        </button>
        <button class="btn" @click="openDdl">
          <AppIcon name="terminal" :size="14" />
          Open DDL in editor
        </button>
      </div>

      <div ref="scroller" class="structure__scroll">
        <section class="panel">
          <h3 class="panel__title">Columns <span class="panel__count">{{ structure.columns.length }}</span></h3>
          <table class="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Type</th>
                <th>Null</th>
                <th>Default</th>
                <th>Extra</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="column in structure.columns" :key="column.name">
                <td class="num">{{ column.position }}</td>
                <td class="mono">
                  {{ column.name }}
                  <span v-if="column.isPrimaryKey" class="badge badge--pk">PK</span>
                </td>
                <td class="mono muted">{{ column.fullType }}</td>
                <td>
                  <span class="structure__flag" :class="{ 'structure__flag--on': column.nullable }">
                    {{ column.nullable ? 'YES' : 'NO' }}
                  </span>
                </td>
                <td class="mono muted truncate">{{ nullLabel(column.defaultValue) }}</td>
                <td class="mono muted">
                  <span v-if="column.isIdentity">
                    IDENTITY({{ column.identitySeed }},{{ column.identityIncrement }})
                  </span>
                  <span v-else-if="column.isComputed">COMPUTED {{ column.computedDefinition }}</span>
                  <span v-else>—</span>
                </td>
                <td class="muted truncate">{{ nullLabel(column.description) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="structure.indexes.length" class="panel">
          <h3 class="panel__title">Indexes <span class="panel__count">{{ structure.indexes.length }}</span></h3>
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Unique</th>
                <th>Type</th>
                <th>Filter</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="index in structure.indexes" :key="index.name">
                <td class="mono">
                  {{ index.name }}
                  <span v-if="index.isPrimaryKey" class="badge badge--pk">PK</span>
                  <span v-if="index.isDisabled" class="badge">disabled</span>
                </td>
                <td class="mono muted">
                  {{
                    index.columns
                      .filter((c) => !c.isIncluded)
                      .map((c) => c.name + (c.descending ? ' ▼' : ''))
                      .join(', ')
                  }}
                  <span v-if="index.columns.some((c) => c.isIncluded)">
                    + INCLUDE ({{ index.columns.filter((c) => c.isIncluded).map((c) => c.name).join(', ') }})
                  </span>
                </td>
                <td>{{ index.isUnique ? 'YES' : 'NO' }}</td>
                <td>{{ index.isClustered ? 'CLUSTERED' : 'NONCLUSTERED' }}</td>
                <td class="mono muted truncate">{{ nullLabel(index.filterDefinition) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="structure.foreignKeys.length" class="panel">
          <h3 class="panel__title">Foreign keys</h3>
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>References</th>
                <th>On delete</th>
                <th>On update</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="fk in structure.foreignKeys" :key="fk.name">
                <td class="mono">{{ fk.name }}</td>
                <td class="mono muted">{{ fk.columns.join(', ') }}</td>
                <td class="mono">
                  {{ fk.referencedSchema }}.{{ fk.referencedTable }} ({{
                    fk.referencedColumns.join(', ')
                  }})
                </td>
                <td>{{ fk.onDelete.replace(/_/g, ' ') }}</td>
                <td>{{ fk.onUpdate.replace(/_/g, ' ') }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="inbound.length" class="panel">
          <h3 class="panel__title">Referenced by</h3>
          <table class="table">
            <thead>
              <tr>
                <th>Constraint</th>
                <th>From</th>
                <th>Columns</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="fk in inbound" :key="fk.name">
                <td class="mono">{{ fk.name }}</td>
                <td class="mono">{{ fk.referencedSchema }}.{{ fk.referencedTable }}</td>
                <td class="mono muted">{{ fk.referencedColumns.join(', ') }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="structure.constraints.length" class="panel">
          <h3 class="panel__title">Constraints</h3>
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Column</th>
                <th>Definition</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="constraint in structure.constraints" :key="constraint.name">
                <td class="mono">{{ constraint.name }}</td>
                <td>{{ constraint.type }}</td>
                <td class="mono muted">{{ nullLabel(constraint.column) }}</td>
                <td class="mono muted truncate">{{ constraint.definition }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="structure.triggers.length" class="panel">
          <h3 class="panel__title">Triggers</h3>
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Events</th>
                <th>Timing</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="trigger in structure.triggers" :key="trigger.name">
                <td class="mono">{{ trigger.name }}</td>
                <td>{{ trigger.events.join(', ') }}</td>
                <td>{{ trigger.isInsteadOf ? 'INSTEAD OF' : 'AFTER' }}</td>
                <td>{{ trigger.isDisabled ? 'disabled' : 'enabled' }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="definition" class="panel">
          <h3 class="panel__title">Definition</h3>
          <pre class="code selectable">{{ definition }}</pre>
        </section>

        <section class="panel">
          <h3 class="panel__title">CREATE script</h3>
          <pre class="code selectable">{{ ddl }}</pre>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.structure {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-surface);
}
/* The same command bar the data view carries, so switching between them moves
   nothing but the content below. */
.structure__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--h-commandbar);
  padding: 0 10px 0 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  flex: 0 0 auto;
}
.structure__title {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: 6px;
  font-size: 13px;
  color: var(--text-muted);
}
.structure__title strong {
  font-weight: 600;
  color: var(--text-primary);
}
.structure__rows {
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
.structure__spacer {
  flex: 1;
}
.structure__toolbar .btn {
  flex: 0 0 auto;
}
.structure__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 20px 24px;
  background: var(--bg-app);
}

/* Each part of the table's definition is a card: a title bar, then its table. */
.panel {
  margin: 0 0 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-surface);
  box-shadow: var(--shadow-xs);
  /* Clipped for the corners, without becoming a scroller — so the column
     headings below can still stick to the top of the pane. */
  overflow: clip;
}
.panel__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 12px 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.panel__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  user-select: text;
}
.table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px 10px;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-app) 50%, var(--bg-surface));
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  white-space: nowrap;
}
.table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
  max-width: 340px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
}
.table tbody tr:last-child td {
  border-bottom: none;
}
/* The name column is the one that reads at full strength. */
.table td.mono:first-child,
.table td:nth-child(2) {
  font-size: 12px;
  color: var(--text-primary);
}
.table td.muted {
  color: var(--text-muted);
}
.table td .badge {
  margin-left: 6px;
  vertical-align: 1px;
}
/* Flush the outer columns with the card's title above them. */
.table th:first-child,
.table td:first-child {
  padding-left: 16px;
}
.table th:last-child,
.table td:last-child {
  padding-right: 16px;
}
.table tbody tr {
  transition: background-color var(--transition);
}
.table tbody tr:hover {
  background: var(--bg-hover);
}
.num {
  width: 56px;
  text-align: right;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
/* YES/NO as a quiet chip, the YES a step brighter. */
.structure__flag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
  color: var(--text-muted);
  font-family: var(--font-ui);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.structure__flag--on {
  color: var(--text-secondary);
}
.code {
  margin: 0 16px 16px;
  padding: 14px 16px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--bg-input);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-secondary);
  overflow-x: auto;
  white-space: pre;
}
</style>
