import { describe, expect, it } from 'vitest'
import {
  foreignKeyFilterValue,
  foreignKeyFilters,
  foreignKeyTargets
} from '../../src/shared/foreignKeys'
import type { CellValue, ColumnMeta, TableForeignKey } from '../../src/shared/types'

function column(name: string, index: number, jsKind: ColumnMeta['jsKind'] = 'number'): ColumnMeta {
  return {
    name,
    index,
    dataType: jsKind === 'number' ? 'int' : 'nvarchar(50)',
    jsKind,
    nullable: true,
    isIdentity: false,
    isReadOnly: false
  }
}

const ORDER_COLUMNS: ColumnMeta[] = [
  column('order_id', 0),
  column('customer_id', 1),
  column('status', 2, 'string')
]

const CUSTOMER_KEY: TableForeignKey = {
  name: 'FK_orders_customers',
  columns: ['customer_id'],
  referencedSchema: 'dbo',
  referencedTable: 'customers',
  referencedColumns: ['customer_id'],
  onDelete: 'CASCADE',
  onUpdate: 'NO_ACTION',
  isDisabled: false
}

describe('foreignKeyTargets', () => {
  it('maps the referencing column index to its target', () => {
    const targets = foreignKeyTargets(ORDER_COLUMNS, [CUSTOMER_KEY])
    expect(Object.keys(targets)).toEqual(['1'])
    expect(targets[1]).toMatchObject({
      schema: 'dbo',
      table: 'customers',
      label: 'dbo.customers.customer_id'
    })
  })

  it('marks every column of a composite key', () => {
    const columns = [column('order_id', 0), column('line_no', 1), column('sku', 2, 'string')]
    const composite: TableForeignKey = {
      ...CUSTOMER_KEY,
      name: 'FK_composite',
      columns: ['order_id', 'line_no'],
      referencedSchema: 'sales',
      referencedTable: 'lines',
      referencedColumns: ['order_id', 'line_no']
    }
    const targets = foreignKeyTargets(columns, [composite])
    expect(Object.keys(targets)).toEqual(['0', '1'])
    expect(targets[1].label).toBe('sales.lines.line_no')
  })

  it('ignores keys whose columns are not in the result set', () => {
    const targets = foreignKeyTargets([column('order_id', 0)], [CUSTOMER_KEY])
    expect(targets).toEqual({})
  })

  it('ignores a malformed key rather than pointing at the wrong column', () => {
    const broken: TableForeignKey = { ...CUSTOMER_KEY, referencedColumns: [] }
    expect(foreignKeyTargets(ORDER_COLUMNS, [broken])).toEqual({})
  })

  it('keeps the first key when two claim the same column', () => {
    const second: TableForeignKey = {
      ...CUSTOMER_KEY,
      name: 'FK_second',
      referencedTable: 'archived_customers'
    }
    const targets = foreignKeyTargets(ORDER_COLUMNS, [CUSTOMER_KEY, second])
    expect(targets[1].table).toBe('customers')
  })
})

describe('foreignKeyFilterValue', () => {
  it('renders the types a key is usually made of', () => {
    expect(foreignKeyFilterValue(42)).toBe('42')
    expect(foreignKeyFilterValue('c7c0…')).toBe('c7c0…')
    expect(foreignKeyFilterValue({ t: 'bigint', v: '90071992547409931' })).toBe(
      '90071992547409931'
    )
  })

  it('renders a bit as the digit SQL Server converts', () => {
    expect(foreignKeyFilterValue(true)).toBe('1')
    expect(foreignKeyFilterValue(false)).toBe('0')
  })

  it('drops the ISO separators a datetime2 cannot parse', () => {
    expect(foreignKeyFilterValue({ t: 'date', v: '2024-05-01T09:30:00.000Z' })).toBe(
      '2024-05-01 09:30:00.000'
    )
  })

  it('refuses NULL and binary values, which have no safe text form', () => {
    expect(foreignKeyFilterValue(null)).toBeNull()
    expect(foreignKeyFilterValue({ t: 'bytes', v: 'deadbeef', n: 4 })).toBeNull()
  })
})

describe('foreignKeyFilters', () => {
  const target = foreignKeyTargets(ORDER_COLUMNS, [CUSTOMER_KEY])[1]

  it('filters the referenced table on the value in the row', () => {
    const row: CellValue[] = [100, 7, 'new']
    expect(foreignKeyFilters(target, ORDER_COLUMNS, row)).toEqual([
      { column: 'customer_id', operator: '=', value: '7', conjunction: 'AND' }
    ])
  })

  it('builds one predicate per column of a composite key', () => {
    const columns = [column('order_id', 0), column('line_no', 1)]
    const composite = foreignKeyTargets(columns, [
      {
        ...CUSTOMER_KEY,
        columns: ['order_id', 'line_no'],
        referencedSchema: 'sales',
        referencedTable: 'lines',
        referencedColumns: ['ref_order', 'ref_line']
      }
    ])[0]

    expect(foreignKeyFilters(composite, columns, [100, 2])).toEqual([
      { column: 'ref_order', operator: '=', value: '100', conjunction: 'AND' },
      { column: 'ref_line', operator: '=', value: '2', conjunction: 'AND' }
    ])
  })

  it('has nothing to follow when the value is NULL', () => {
    expect(foreignKeyFilters(target, ORDER_COLUMNS, [100, null, 'new'])).toBeNull()
  })
})
