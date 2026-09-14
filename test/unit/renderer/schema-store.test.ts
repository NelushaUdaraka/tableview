/**
 * Opening a table in the tree, and what that costs.
 *
 * The tree is the one place a table's structure is asked for without being
 * asked for: a twisty is cheap to click and there may be a hundred tables in
 * the list. So the read happens once per table, is kept, survives the table
 * being closed and opened again, and a failure stays with the table it belongs
 * to rather than becoming a message about the schema.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchemaObject, TableStructure } from '../../../src/shared/types'

const getTableStructure = vi.fn()
const listObjects = vi.fn()

vi.mock('../../../src/renderer/src/lib/api', () => ({
  api: {
    listDatabases: () => Promise.resolve([]),
    listObjects: () => listObjects(),
    listRoutines: () => Promise.resolve([]),
    getAutocompleteSchema: () => Promise.resolve({}),
    getTableStructure: (...args: unknown[]) => getTableStructure(...args)
  }
}))

const { useSchemaStore } = await import('../../../src/renderer/src/stores/schema')

function structure(name: string, columns: string[]): TableStructure {
  return {
    schema: 'dbo',
    name,
    type: 'table',
    columns: columns.map((column, position) => ({
      name: column,
      position: position + 1,
      dataType: 'int',
      fullType: 'int',
      maxLength: null,
      precision: 10,
      scale: 0,
      nullable: false,
      defaultValue: null,
      isIdentity: false,
      isComputed: false,
      isPrimaryKey: position === 0,
      collation: null,
      description: null
    })),
    primaryKey: [columns[0]],
    indexes: [],
    foreignKeys: [],
    triggers: [],
    constraints: [],
    rowCountEstimate: null
  }
}

const customers: SchemaObject = { schema: 'dbo', name: 'customers', type: 'table' }

/** Lets the store's un-awaited reads finish before anything is asserted. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  listObjects.mockResolvedValue([customers])
  getTableStructure.mockImplementation((_id: string, _schema: string, table: string) =>
    Promise.resolve(structure(table, ['customer_id', 'email']))
  )
})

describe('opening a table', () => {
  it('reads its structure, and holds it where the tree can draw it', async () => {
    const schema = useSchemaStore()

    schema.toggleObject('c1', 'dbo', 'customers')
    await settled()

    expect(schema.isObjectExpanded('dbo', 'customers')).toBe(true)
    expect(schema.structureState('dbo', 'customers')).toBe('ready')
    expect(schema.structureOf('dbo', 'customers')?.columns.map((column) => column.name)).toEqual([
      'customer_id',
      'email'
    ])
  })

  it('reads it once, however often it is opened and closed', async () => {
    const schema = useSchemaStore()

    schema.toggleObject('c1', 'dbo', 'customers')
    await settled()
    schema.toggleObject('c1', 'dbo', 'customers')
    schema.toggleObject('c1', 'dbo', 'customers')
    await settled()

    expect(getTableStructure).toHaveBeenCalledTimes(1)
    expect(schema.structureOf('dbo', 'customers')).not.toBeNull()
  })

  it('keeps a failure against the table, and lets it be tried again', async () => {
    const schema = useSchemaStore()
    getTableStructure.mockRejectedValueOnce(new Error('The connection dropped'))

    schema.toggleObject('c1', 'dbo', 'customers')
    await settled()

    expect(schema.structureState('dbo', 'customers')).toBe('error')
    expect(schema.structureError('dbo', 'customers')).toBe('The connection dropped')

    // Nothing was cached, so opening it again asks again.
    schema.toggleObject('c1', 'dbo', 'customers')
    schema.toggleObject('c1', 'dbo', 'customers')
    await settled()

    expect(schema.structureState('dbo', 'customers')).toBe('ready')
    expect(schema.structureError('dbo', 'customers')).toBeNull()
  })

  it('asks for nothing when it is closed again', async () => {
    const schema = useSchemaStore()

    schema.toggleObject('c1', 'dbo', 'customers')
    await settled()
    schema.toggleObject('c1', 'dbo', 'customers')

    expect(schema.isObjectExpanded('dbo', 'customers')).toBe(false)
    expect(getTableStructure).toHaveBeenCalledTimes(1)
  })
})

describe('the folders under a table', () => {
  it('opens on its columns, which is what a table is usually opened for', () => {
    const schema = useSchemaStore()

    expect(schema.isFolderOpen('dbo', 'customers', 'columns')).toBe(true)
    expect(schema.isFolderOpen('dbo', 'customers', 'indexes')).toBe(false)
  })

  it('remembers each folder of each table separately', () => {
    const schema = useSchemaStore()

    schema.toggleFolder('dbo', 'customers', 'indexes')
    schema.toggleFolder('dbo', 'customers', 'columns')

    expect(schema.isFolderOpen('dbo', 'customers', 'indexes')).toBe(true)
    expect(schema.isFolderOpen('dbo', 'customers', 'columns')).toBe(false)
    // Another table has its own answer, and it is still the default one.
    expect(schema.isFolderOpen('dbo', 'orders', 'columns')).toBe(true)
    expect(schema.isFolderOpen('dbo', 'orders', 'indexes')).toBe(false)
  })
})

describe('refreshing the schema', () => {
  it('reads an open table again rather than emptying it', async () => {
    const schema = useSchemaStore()

    schema.toggleObject('c1', 'dbo', 'customers')
    await settled()

    getTableStructure.mockResolvedValue(structure('customers', ['customer_id', 'email', 'phone']))
    await schema.loadAll('c1')
    await settled()

    expect(schema.isObjectExpanded('dbo', 'customers')).toBe(true)
    expect(schema.structureOf('dbo', 'customers')?.columns).toHaveLength(3)
  })

  it('does not go looking for a table that is no longer there', async () => {
    const schema = useSchemaStore()

    schema.toggleObject('c1', 'dbo', 'customers')
    await settled()

    // Dropped between one refresh and the next.
    listObjects.mockResolvedValue([])
    getTableStructure.mockClear()
    await schema.loadAll('c1')
    await settled()

    expect(getTableStructure).not.toHaveBeenCalled()
  })

  it('closes everything when the connection goes', async () => {
    const schema = useSchemaStore()

    schema.toggleObject('c1', 'dbo', 'customers')
    schema.toggleFolder('dbo', 'customers', 'indexes')
    await settled()

    schema.reset()

    expect(schema.isObjectExpanded('dbo', 'customers')).toBe(false)
    expect(schema.isFolderOpen('dbo', 'customers', 'indexes')).toBe(false)
    expect(schema.structureOf('dbo', 'customers')).toBeNull()
  })
})
