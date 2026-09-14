/**
 * What a table opens into in the sidebar tree.
 *
 * Columns, foreign keys and indexes come back from the catalog as themselves;
 * "keys" do not. SQL Server backs a primary key and a unique constraint with
 * an index of the same name, so the same key is reported two or three ways and
 * the tree has to show it once — whichever way the DDL happened to say it.
 */
import { describe, expect, it } from 'vitest'
import type { TableIndex, TableStructure } from '../../../src/shared/types'
import {
  foreignKeyTarget,
  indexColumnList,
  structureTree,
  tableKeys
} from '../../../src/renderer/src/lib/schemaTree'

function index(overrides: Partial<TableIndex> & { name: string }): TableIndex {
  return {
    isUnique: false,
    isPrimaryKey: false,
    isClustered: false,
    isDisabled: false,
    filterDefinition: null,
    columns: [],
    ...overrides
  }
}

function columns(...names: string[]): TableIndex['columns'] {
  return names.map((name) => ({ name, descending: false, isIncluded: false }))
}

function structure(overrides: Partial<TableStructure> = {}): TableStructure {
  return {
    schema: 'dbo',
    name: 'customers',
    type: 'table',
    columns: [],
    primaryKey: [],
    indexes: [],
    foreignKeys: [],
    triggers: [],
    constraints: [],
    rowCountEstimate: null,
    ...overrides
  }
}

describe('tableKeys', () => {
  it('reads the primary key off the index that backs it', () => {
    const keys = tableKeys(
      structure({
        primaryKey: ['customer_id'],
        indexes: [
          index({ name: 'PK_customers', isPrimaryKey: true, isUnique: true, isClustered: true, columns: columns('customer_id') })
        ]
      })
    )

    expect(keys).toEqual([{ name: 'PK_customers', kind: 'primary', columns: ['customer_id'] }])
  })

  it('counts a unique constraint and the index behind it as one key', () => {
    const keys = tableKeys(
      structure({
        indexes: [index({ name: 'UQ_customers_email', isUnique: true, columns: columns('email') })],
        constraints: [
          { name: 'UQ_customers_email', type: 'unique', definition: 'email', column: null }
        ]
      })
    )

    expect(keys).toEqual([{ name: 'UQ_customers_email', kind: 'unique', columns: ['email'] }])
  })

  it('takes a unique constraint that named no index of its own', () => {
    const keys = tableKeys(
      structure({
        constraints: [
          { name: 'UQ_pair', type: 'unique', definition: 'tenant_id, email', column: null },
          { name: 'CK_age', type: 'check', definition: '([age]>(0))', column: null },
          { name: 'DF_created', type: 'default', definition: '(getutcdate())', column: 'created_at' }
        ]
      })
    )

    // Check and default constraints are not keys, whatever else they are.
    expect(keys).toEqual([{ name: 'UQ_pair', kind: 'unique', columns: ['tenant_id', 'email'] }])
  })

  it('names a primary key the catalog gave no index for', () => {
    const keys = tableKeys(structure({ primaryKey: ['a', 'b'] }))

    expect(keys).toEqual([{ name: 'PRIMARY KEY', kind: 'primary', columns: ['a', 'b'] }])
  })

  it('leaves INCLUDE columns out of a key: they are carried, not identifying', () => {
    const keys = tableKeys(
      structure({
        indexes: [
          index({
            name: 'UQ_covering',
            isUnique: true,
            columns: [
              { name: 'email', descending: false, isIncluded: false },
              { name: 'display_name', descending: false, isIncluded: true }
            ]
          })
        ]
      })
    )

    expect(keys[0].columns).toEqual(['email'])
  })

  it('puts the primary key first and the rest in order', () => {
    const keys = tableKeys(
      structure({
        indexes: [
          index({ name: 'UQ_zebra', isUnique: true, columns: columns('zebra') }),
          index({ name: 'UQ_alpha', isUnique: true, columns: columns('alpha') }),
          index({ name: 'PK_customers', isPrimaryKey: true, isUnique: true, columns: columns('id') }),
          // An ordinary index is not a key, however useful it is.
          index({ name: 'IX_created_at', columns: columns('created_at') })
        ]
      })
    )

    expect(keys.map((key) => key.name)).toEqual(['PK_customers', 'UQ_alpha', 'UQ_zebra'])
  })
})

describe('structureTree', () => {
  it('is the four folders the tree shows, with what each holds', () => {
    const tree = structureTree(
      structure({
        columns: [
          {
            name: 'id',
            position: 1,
            dataType: 'int',
            fullType: 'int',
            maxLength: null,
            precision: 10,
            scale: 0,
            nullable: false,
            defaultValue: null,
            isIdentity: true,
            isComputed: false,
            isPrimaryKey: true,
            collation: null,
            description: null
          }
        ],
        primaryKey: ['id'],
        foreignKeys: [
          {
            name: 'FK_orders_customers',
            columns: ['customer_id'],
            referencedSchema: 'dbo',
            referencedTable: 'customers',
            referencedColumns: ['customer_id'],
            onDelete: 'NO_ACTION',
            onUpdate: 'NO_ACTION',
            isDisabled: false
          }
        ],
        indexes: [index({ name: 'IX_customer_id', columns: columns('customer_id') })]
      })
    )

    expect(tree.columns).toHaveLength(1)
    expect(tree.keys).toHaveLength(1)
    expect(tree.foreignKeys).toHaveLength(1)
    expect(tree.indexes).toHaveLength(1)
  })
})

describe('index and foreign key lines', () => {
  it('marks a descending key column and sets INCLUDE apart', () => {
    const line = indexColumnList(
      index({
        name: 'IX_recent',
        columns: [
          { name: 'created_at', descending: true, isIncluded: false },
          { name: 'customer_id', descending: false, isIncluded: false },
          { name: 'total', descending: false, isIncluded: true }
        ]
      })
    )

    expect(line).toBe('created_at ▼, customer_id + total')
  })

  it('says where a foreign key points, composite keys included', () => {
    expect(
      foreignKeyTarget({
        name: 'FK_items_order',
        columns: ['order_id', 'line_no'],
        referencedSchema: 'sales',
        referencedTable: 'order_lines',
        referencedColumns: ['order_id', 'line_no'],
        onDelete: 'CASCADE',
        onUpdate: 'NO_ACTION',
        isDisabled: false
      })
    ).toBe('sales.order_lines(order_id, line_no)')
  })
})
