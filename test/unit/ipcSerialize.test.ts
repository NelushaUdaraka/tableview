import { describe, expect, it } from 'vitest'
import { toPlain } from '../../src/shared/ipcSerialize'

/** Stands in for a Vue reactive proxy: structured clone rejects any Proxy. */
function reactiveLike<T extends object>(target: T): T {
  return new Proxy(target, {
    get: (obj, key, receiver) => Reflect.get(obj, key, receiver)
  })
}

describe('toPlain', () => {
  it('passes primitives through untouched', () => {
    expect(toPlain('a')).toBe('a')
    expect(toPlain(1)).toBe(1)
    expect(toPlain(true)).toBe(true)
    expect(toPlain(null)).toBeNull()
    expect(toPlain(undefined)).toBeUndefined()
  })

  it('rebuilds plain objects and arrays with the same contents', () => {
    expect(toPlain({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' })
    expect(toPlain([1, 'a', null])).toEqual([1, 'a', null])
    expect(toPlain({ a: { b: { c: [1, 2] } } })).toEqual({ a: { b: { c: [1, 2] } } })
  })

  // structuredClone here stands in for what contextBridge does to arguments.
  it('produces a value structuredClone accepts, where the proxy did not', () => {
    const proxied = reactiveLike({ sorts: [{ column: 'id', direction: 'asc' }] })
    // The proxy itself cannot cross the IPC boundary…
    expect(() => structuredClone(proxied)).toThrow()
    // …but its plain rebuild can.
    const plain = toPlain(proxied)
    expect(() => structuredClone(plain)).not.toThrow()
    expect(plain).toEqual({ sorts: [{ column: 'id', direction: 'asc' }] })
  })

  it('unwraps proxies nested inside arrays and objects', () => {
    const request = {
      filters: [reactiveLike({ column: 'a', operator: '=', value: '1' })],
      nested: reactiveLike({ deep: reactiveLike({ value: 7 }) })
    }
    const plain = toPlain(request)
    expect(() => structuredClone(plain)).not.toThrow()
    expect(plain).toEqual({
      filters: [{ column: 'a', operator: '=', value: '1' }],
      nested: { deep: { value: 7 } }
    })
  })

  it('handles a realistic table-data request built from reactive state', () => {
    const proxied = reactiveLike({
      connectionId: 'c1',
      schema: 'dbo',
      table: 'customers',
      offset: 0,
      limit: 200,
      sorts: reactiveLike([reactiveLike({ column: 'id', direction: 'asc' })]),
      filters: reactiveLike([]),
      filterMode: 'builder',
      rawWhere: ''
    })
    expect(() => structuredClone(toPlain(proxied))).not.toThrow()
  })

  it('keeps types that already clone correctly', () => {
    const date = new Date('2024-01-01T00:00:00.000Z')
    expect(toPlain(date)).toBe(date)

    const bytes = new Uint8Array([1, 2, 3])
    expect(toPlain(bytes)).toBe(bytes)
  })

  it('does not choke on a large result payload', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => [i, `row ${i}`, null])
    const plain = toPlain({ rows })
    expect(plain.rows).toHaveLength(5000)
    expect(plain.rows[4999]).toEqual([4999, 'row 4999', null])
  })
})
