/**
 * A table's structure as the sidebar tree shows it.
 *
 * The structure view spells everything out in tables; the tree has an indent
 * and a line per thing, so it shows the four that answer "what is in here" —
 * columns, keys, foreign keys, indexes — and leaves the rest (triggers, check
 * and default constraints, identity seeds) to the view with room for them.
 */
import type {
  TableColumn,
  TableForeignKey,
  TableIndex,
  TableStructure
} from '@shared/types'

/** The folders a table opens into, in the order they are shown. */
export const STRUCTURE_FOLDERS = ['columns', 'keys', 'foreignKeys', 'indexes'] as const

export type StructureFolder = (typeof STRUCTURE_FOLDERS)[number]

export const FOLDER_LABELS: Record<StructureFolder, string> = {
  columns: 'columns',
  keys: 'keys',
  foreignKeys: 'foreign keys',
  indexes: 'indexes'
}

/** A primary or unique key, whichever of the two kinds declared it. */
export interface TableKey {
  name: string
  kind: 'primary' | 'unique'
  columns: string[]
}

export interface StructureTree {
  columns: TableColumn[]
  keys: TableKey[]
  foreignKeys: TableForeignKey[]
  indexes: TableIndex[]
}

/**
 * The keys of a table, however they were declared.
 *
 * SQL Server backs a primary key and a unique constraint with an index of the
 * same name, so the indexes are the fullest account of both and are read
 * first; a unique constraint that named no index of its own is added after,
 * and so is a primary key reported without one. Which leaves each key once,
 * whether the DDL said `PRIMARY KEY`, `UNIQUE` or `CREATE UNIQUE INDEX`.
 */
export function tableKeys(structure: TableStructure): TableKey[] {
  const keys: TableKey[] = []
  const named = new Set<string>()

  for (const index of structure.indexes) {
    if (!index.isPrimaryKey && !index.isUnique) continue
    named.add(index.name)
    keys.push({
      name: index.name,
      kind: index.isPrimaryKey ? 'primary' : 'unique',
      // An INCLUDE column rides along in the index; it is not part of the key.
      columns: index.columns.filter((column) => !column.isIncluded).map((column) => column.name)
    })
  }

  for (const constraint of structure.constraints) {
    if (constraint.type !== 'unique' || named.has(constraint.name)) continue
    named.add(constraint.name)
    keys.push({
      name: constraint.name,
      kind: 'unique',
      // The definition is the constraint's column list, as the catalog wrote it.
      columns: splitColumns(constraint.definition, constraint.column)
    })
  }

  if (structure.primaryKey.length > 0 && !keys.some((key) => key.kind === 'primary')) {
    keys.push({ name: 'PRIMARY KEY', kind: 'primary', columns: [...structure.primaryKey] })
  }

  // The primary key leads; the rest are alphabetical, as the indexes are.
  return keys.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'primary' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function splitColumns(definition: string, column: string | null): string[] {
  if (column) return [column]
  return definition
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

export function structureTree(structure: TableStructure): StructureTree {
  return {
    columns: structure.columns,
    keys: tableKeys(structure),
    foreignKeys: structure.foreignKeys,
    indexes: structure.indexes
  }
}

/** How many a folder holds, which is what the tree shows beside its name. */
export function folderCount(tree: StructureTree, folder: StructureFolder): number {
  return tree[folder].length
}

/** The key columns of an index, as one line: `customer_id, created_at ▼`. */
export function indexColumnList(index: TableIndex): string {
  const keyColumns = index.columns
    .filter((column) => !column.isIncluded)
    .map((column) => `${column.name}${column.descending ? ' ▼' : ''}`)
  const included = index.columns.filter((column) => column.isIncluded).map((column) => column.name)
  const list = keyColumns.join(', ')
  return included.length > 0 ? `${list} + ${included.join(', ')}` : list
}

/** `dbo.customers(id)` — where a foreign key points. */
export function foreignKeyTarget(key: TableForeignKey): string {
  return `${key.referencedSchema}.${key.referencedTable}(${key.referencedColumns.join(', ')})`
}
