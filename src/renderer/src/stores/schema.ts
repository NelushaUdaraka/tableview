import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  DatabaseSummary,
  RoutineObject,
  SchemaObject,
  TableStructure
} from '@shared/types'
import { api } from '../lib/api'
import { useBusyStore } from './busy'

/** Groups objects under their schema for the sidebar tree. */
export interface SchemaGroup {
  schema: string
  tables: SchemaObject[]
  views: SchemaObject[]
  routines: RoutineObject[]
}

export const useSchemaStore = defineStore('schema', () => {
  const databases = ref<DatabaseSummary[]>([])
  const objects = ref<SchemaObject[]>([])
  const routines = ref<RoutineObject[]>([])
  const structures = ref<Record<string, TableStructure>>({})
  const autocomplete = ref<Record<string, string[]>>({})
  const loading = ref(false)
  const filter = ref('')
  const showSystemDatabases = ref(false)
  const expanded = ref<Record<string, boolean>>({ dbo: true })
  const pinned = ref<string[]>([])

  const visibleDatabases = computed(() =>
    showSystemDatabases.value ? databases.value : databases.value.filter((db) => !db.isSystem)
  )

  const groups = computed<SchemaGroup[]>(() => {
    const needle = filter.value.trim().toLowerCase()
    const matches = (name: string, schema: string): boolean =>
      needle === '' ||
      name.toLowerCase().includes(needle) ||
      `${schema}.${name}`.toLowerCase().includes(needle)

    const bySchema = new Map<string, SchemaGroup>()
    const ensure = (schema: string): SchemaGroup => {
      let group = bySchema.get(schema)
      if (!group) {
        group = { schema, tables: [], views: [], routines: [] }
        bySchema.set(schema, group)
      }
      return group
    }

    for (const object of objects.value) {
      if (!matches(object.name, object.schema)) continue
      const group = ensure(object.schema)
      if (object.type === 'view') group.views.push(object)
      else group.tables.push(object)
    }
    for (const routine of routines.value) {
      if (!matches(routine.name, routine.schema)) continue
      ensure(routine.schema).routines.push(routine)
    }

    return [...bySchema.values()]
      .filter(
        (group) =>
          group.tables.length > 0 || group.views.length > 0 || group.routines.length > 0
      )
      .sort((a, b) => {
        // `dbo` is where almost everything lives, so it leads.
        if (a.schema === 'dbo') return -1
        if (b.schema === 'dbo') return 1
        return a.schema.localeCompare(b.schema)
      })
  })

  const totalObjects = computed(() => objects.value.length + routines.value.length)

  function key(schema: string, table: string): string {
    return `${schema}.${table}`
  }

  async function loadAll(connectionId: string): Promise<void> {
    const busy = useBusyStore()
    loading.value = true
    busy.begin()
    try {
      const [dbs, objs, procs] = await Promise.all([
        api.listDatabases(connectionId),
        api.listObjects(connectionId),
        api.listRoutines(connectionId)
      ])
      databases.value = dbs
      objects.value = objs
      routines.value = procs
      structures.value = {}
      // Autocomplete metadata is a nice-to-have; never block the tree on it.
      api
        .getAutocompleteSchema(connectionId)
        .then((map) => {
          autocomplete.value = map
        })
        .catch(() => undefined)
    } finally {
      loading.value = false
      busy.end()
    }
  }

  async function getStructure(
    connectionId: string,
    schema: string,
    table: string,
    force = false
  ): Promise<TableStructure> {
    const cacheKey = key(schema, table)
    if (!force && structures.value[cacheKey]) return structures.value[cacheKey]
    const structure = await api.getTableStructure(connectionId, schema, table)
    structures.value = { ...structures.value, [cacheKey]: structure }
    return structure
  }

  function toggleExpanded(schema: string): void {
    expanded.value = { ...expanded.value, [schema]: !expanded.value[schema] }
  }

  function togglePinned(schema: string, table: string): void {
    const cacheKey = key(schema, table)
    pinned.value = pinned.value.includes(cacheKey)
      ? pinned.value.filter((entry) => entry !== cacheKey)
      : [...pinned.value, cacheKey]
  }

  function isPinned(schema: string, table: string): boolean {
    return pinned.value.includes(key(schema, table))
  }

  function reset(): void {
    databases.value = []
    objects.value = []
    routines.value = []
    structures.value = {}
    autocomplete.value = {}
    pinned.value = []
    filter.value = ''
  }

  return {
    databases,
    visibleDatabases,
    showSystemDatabases,
    objects,
    routines,
    structures,
    autocomplete,
    loading,
    filter,
    expanded,
    pinned,
    groups,
    totalObjects,
    loadAll,
    getStructure,
    toggleExpanded,
    togglePinned,
    isPinned,
    reset
  }
})
