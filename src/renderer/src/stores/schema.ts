import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  DatabaseSummary,
  RoutineObject,
  SchemaObject,
  TableStructure
} from '@shared/types'
import { api } from '../lib/api'
import { structureTree, type StructureFolder, type StructureTree } from '../lib/schemaTree'
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
  /**
   * Which tables in the tree are open, and which of their folders.
   *
   * Both are keyed by qualified name rather than held on the objects, because
   * the objects are replaced wholesale every time the schema is read: state
   * kept on them would be thrown away by a refresh the user did not think of
   * as closing anything.
   */
  const expandedObjects = ref<Record<string, boolean>>({})
  const openFolders = ref<Record<string, boolean>>({})
  const structuresLoading = ref<Record<string, boolean>>({})
  const structureErrors = ref<Record<string, string>>({})

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

  /** The same record without one entry — every write here replaces the map. */
  function without<T>(record: Record<string, T>, drop: string): Record<string, T> {
    return Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== drop))
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
      // A table left open in the tree stays open, so its structure is read
      // again rather than left empty — but not waited for: the tree is what
      // the refresh was asked for. A table that is no longer there is not in
      // this list, so it is not asked for either.
      for (const object of objs) {
        if (expandedObjects.value[key(object.schema, object.name)]) {
          void readStructure(connectionId, object.schema, object.name, true)
        }
      }
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

  /**
   * Reads a table's structure for the tree, recording how it went.
   *
   * The tree cannot throw at the user the way a view can — an expanded row is
   * not a page — so a failure is kept against the table and shown under it,
   * and a second attempt is only ever a collapse and expand away.
   */
  async function readStructure(
    connectionId: string,
    schema: string,
    table: string,
    force = false
  ): Promise<void> {
    const cacheKey = key(schema, table)
    if (!force && structures.value[cacheKey]) return
    structuresLoading.value = { ...structuresLoading.value, [cacheKey]: true }
    structureErrors.value = without(structureErrors.value, cacheKey)
    try {
      await getStructure(connectionId, schema, table, force)
    } catch (error) {
      structureErrors.value = {
        ...structureErrors.value,
        [cacheKey]: error instanceof Error ? error.message : String(error)
      }
    } finally {
      structuresLoading.value = without(structuresLoading.value, cacheKey)
    }
  }

  /** Opens or closes a table in the tree, reading its structure the first time. */
  function toggleObject(connectionId: string, schema: string, table: string): void {
    const cacheKey = key(schema, table)
    const open = !expandedObjects.value[cacheKey]
    expandedObjects.value = { ...expandedObjects.value, [cacheKey]: open }
    if (open) void readStructure(connectionId, schema, table)
  }

  function isObjectExpanded(schema: string, table: string): boolean {
    return expandedObjects.value[key(schema, table)] === true
  }

  function structureOf(schema: string, table: string): StructureTree | null {
    const structure = structures.value[key(schema, table)]
    return structure ? structureTree(structure) : null
  }

  function structureState(schema: string, table: string): 'loading' | 'error' | 'ready' {
    const cacheKey = key(schema, table)
    if (structuresLoading.value[cacheKey]) return 'loading'
    if (structureErrors.value[cacheKey]) return 'error'
    return 'ready'
  }

  function structureError(schema: string, table: string): string | null {
    return structureErrors.value[key(schema, table)] ?? null
  }

  function folderKey(schema: string, table: string, folder: StructureFolder): string {
    return `${key(schema, table)}:${folder}`
  }

  /** Columns are what a table is usually opened for, so they open with it. */
  function isFolderOpen(schema: string, table: string, folder: StructureFolder): boolean {
    return openFolders.value[folderKey(schema, table, folder)] ?? folder === 'columns'
  }

  function toggleFolder(schema: string, table: string, folder: StructureFolder): void {
    const cacheKey = folderKey(schema, table, folder)
    openFolders.value = {
      ...openFolders.value,
      [cacheKey]: !isFolderOpen(schema, table, folder)
    }
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
    expandedObjects.value = {}
    openFolders.value = {}
    structuresLoading.value = {}
    structureErrors.value = {}
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
    expandedObjects,
    openFolders,
    toggleObject,
    isObjectExpanded,
    structureOf,
    structureState,
    structureError,
    isFolderOpen,
    toggleFolder,
    toggleExpanded,
    togglePinned,
    isPinned,
    reset
  }
})
