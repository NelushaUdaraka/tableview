<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { TableForeignKey, TableStructure } from '@shared/types'
import { buildCreateTableDdl } from '@shared/sql/builder'
import { useSchemaStore } from '../stores/schema'
import { useToastStore } from '../stores/toasts'
import type { TableTab } from '../stores/tabs'
import { api } from '../lib/api'

const props = defineProps<{ tab: TableTab }>()
const emit = defineEmits<{ (event: 'open-sql', sql: string, title: string): void }>()

const schemaStore = useSchemaStore()
const toasts = useToastStore()

const structure = ref<TableStructure | null>(null)
const inbound = ref<TableForeignKey[]>([])
const definition = ref<string | null>(null)
const loading = ref(true)

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
        <span class="structure__title mono">
          {{ structure.schema }}.{{ structure.name }}
        </span>
        <span class="badge">{{ structure.type }}</span>
        <span v-if="structure.rowCountEstimate !== null" class="muted">
          ~{{ structure.rowCountEstimate.toLocaleString() }} rows
        </span>
        <div class="structure__spacer"></div>
        <button class="btn btn--sm btn--ghost" @click="copyDdl">Copy DDL</button>
        <button class="btn btn--sm" @click="openDdl">Open DDL in editor</button>
      </div>

      <div class="structure__scroll">
        <section class="panel">
          <h3 class="panel__title">Columns <span class="muted">({{ structure.columns.length }})</span></h3>
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
                <td>{{ column.nullable ? 'YES' : 'NO' }}</td>
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
          <h3 class="panel__title">Indexes <span class="muted">({{ structure.indexes.length }})</span></h3>
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
.structure__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
  flex: 0 0 auto;
}
.structure__title {
  font-weight: 600;
}
.structure__spacer {
  flex: 1;
}
.structure__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px;
}
.panel {
  margin-bottom: 22px;
}
.panel__title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  user-select: text;
}
.table th {
  position: sticky;
  top: 0;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-strong);
  background: var(--bg-raised);
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-secondary);
  white-space: nowrap;
}
.table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  max-width: 340px;
}
.table tbody tr:hover {
  background: var(--bg-hover);
}
.num {
  text-align: right;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.code {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  overflow-x: auto;
  white-space: pre;
}
</style>
