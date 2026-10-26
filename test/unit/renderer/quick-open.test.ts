/**
 * Quick open: matching names as they are typed, and ranking so the likely
 * table is first — pinned and recently opened ones ahead of the rest.
 */
import { describe, expect, it } from 'vitest'
import {
  fuzzyMatch,
  quickOpenItems,
  rankQuickOpen,
  touchRecent
} from '../../../src/renderer/src/lib/quickOpen'
import type { RoutineObject, SavedQuery, SchemaObject } from '../../../src/shared/types'

const objects: SchemaObject[] = [
  { schema: 'dbo', name: 'orders', type: 'table', rowCountEstimate: 1200 },
  { schema: 'dbo', name: 'order_items', type: 'table', rowCountEstimate: 5400 },
  { schema: 'sales', name: 'invoice', type: 'table' },
  { schema: 'sales', name: 'v_order_totals', type: 'view' },
  { schema: 'dbo', name: 'customers', type: 'table' }
]
const routines: RoutineObject[] = [
  { schema: 'dbo', name: 'usp_place_order', type: 'procedure' },
  { schema: 'dbo', name: 'fn_total', type: 'scalar-function' }
]
const saved: SavedQuery[] = [
  { id: 'q1', name: 'Monthly orders report', sql: 'SELECT 1', createdAt: '', updatedAt: '' }
]

const items = quickOpenItems(objects, routines, saved, ['dbo.customers'])
const names = (query: string, recent: string[] = []): string[] =>
  rankQuickOpen(items, query, recent).map((match) => match.item.name)

describe('quickOpenItems', () => {
  it('lists tables, views, routines and saved queries with their kind', () => {
    expect(items.map((item) => [item.kind, item.name])).toEqual([
      ['table', 'orders'],
      ['table', 'order_items'],
      ['table', 'invoice'],
      ['view', 'v_order_totals'],
      ['table', 'customers'],
      ['procedure', 'usp_place_order'],
      ['function', 'fn_total'],
      ['query', 'Monthly orders report']
    ])
  })

  it('marks pinned tables and keeps the row estimate', () => {
    expect(items.find((item) => item.name === 'customers')?.pinned).toBe(true)
    expect(items.find((item) => item.name === 'orders')?.rowCountEstimate).toBe(1200)
  })
})

describe('fuzzyMatch', () => {
  it('ranks a whole name over a prefix over a substring over scattered letters', () => {
    const exact = fuzzyMatch('orders', 'orders')!.score
    const prefix = fuzzyMatch('order', 'orders')!.score
    const inside = fuzzyMatch('order', 'v_order_totals')!.score
    const scattered = fuzzyMatch('ors', 'orders_x')!.score
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(inside)
    expect(inside).toBeGreaterThan(scattered)
  })

  it('matches letters in order wherever they are, case aside', () => {
    expect(fuzzyMatch('OI', 'order_items')?.positions).toEqual([0, 6])
    expect(fuzzyMatch('xyz', 'orders')).toBeNull()
  })

  it('lines letters up with word starts, so an acronym finds its name', () => {
    expect(fuzzyMatch('upo', 'usp_place_order')?.positions).toEqual([0, 4, 10])
    expect(fuzzyMatch('gc', 'getCustomer')?.positions).toEqual([0, 3])
  })
})

describe('rankQuickOpen', () => {
  it('puts pinned first, then recent, then the rest by kind and name, with nothing typed', () => {
    expect(names('', ['routine:dbo.fn_total', 'object:sales.invoice'])).toEqual([
      'customers',
      'fn_total',
      'invoice',
      'order_items',
      'orders',
      'v_order_totals',
      'usp_place_order',
      'Monthly orders report'
    ])
  })

  it('lists the best match first', () => {
    expect(names('orders')[0]).toBe('orders')
    expect(names('oi')[0]).toBe('order_items')
  })

  it('lifts a recently opened item over an equal match', () => {
    const plain = names('order')
    expect(plain.indexOf('orders')).toBeLessThan(plain.indexOf('order_items'))
    const lifted = names('order', ['object:dbo.order_items'])
    expect(lifted.indexOf('order_items')).toBeLessThan(lifted.indexOf('orders'))
  })

  it('finds saved queries and routines by name', () => {
    expect(names('monthly')).toEqual(['Monthly orders report'])
    expect(names('place')).toEqual(['usp_place_order'])
  })

  it('matches over the schema when the query names one', () => {
    const [match] = rankQuickOpen(items, 'sales.inv', [])
    expect(match.item.name).toBe('invoice')
    expect(match.schemaPositions).toEqual([0, 1, 2, 3, 4])
    expect(match.namePositions).toEqual([0, 1, 2])
  })

  it('returns nothing for a query nothing matches', () => {
    expect(names('zzz')).toEqual([])
  })

  it('stops at the limit', () => {
    expect(rankQuickOpen(items, '', [], 3)).toHaveLength(3)
  })
})

describe('touchRecent', () => {
  it('keeps the most recent first, each once, up to the cap', () => {
    expect(touchRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(touchRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a'])
  })
})
