/**
 * What the confirm-writes question lists, and when a typed name counts.
 */
import { describe, expect, it } from 'vitest'
import {
  dropWrite,
  namesIt,
  scriptWrites,
  truncateWrite
} from '../../../src/renderer/src/lib/confirmWrites'

describe('scriptWrites', () => {
  it('lists nothing for a script that only reads', () => {
    expect(scriptWrites('SELECT 1', 'sales')).toEqual([])
  })

  it('says where each write lands, following a USE', () => {
    expect(
      scriptWrites('UPDATE t SET a = 1 WHERE id = 1\nUSE archive\nDELETE FROM t', 'sales')
    ).toEqual([
      { line: 1, description: 'UPDATE changes data', database: 'sales', danger: undefined },
      {
        line: 3,
        description: 'DELETE changes data',
        database: 'archive',
        danger: { name: 't', reason: 'has no WHERE, so it deletes every row of t' }
      }
    ])
  })
})

describe('truncate and drop from the tree', () => {
  it('want the name typed', () => {
    expect(truncateWrite('dbo', 'orders', 'sales').danger?.name).toBe('orders')
    expect(dropWrite('dbo', 'v_orders', 'view', 'sales')).toMatchObject({
      description: 'DROP VIEW removes dbo.v_orders',
      danger: { name: 'v_orders' }
    })
  })
})

describe('namesIt', () => {
  it('takes the whole name, in any case, with space around it', () => {
    expect(namesIt(' Orders ', 'orders')).toBe(true)
    expect(namesIt('order', 'orders')).toBe(false)
    expect(namesIt('', 'orders')).toBe(false)
  })
})
