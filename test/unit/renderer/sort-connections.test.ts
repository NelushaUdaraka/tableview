/**
 * Ordering the saved connection list.
 *
 * The four keys are not four variations on one comparison: a name is text, a
 * created date is an instant, and a connection that has never been opened has
 * no last-opened instant at all. What this covers is that each key reads the
 * way the picker's label promises, and that the rows with nothing to compare
 * stay out of the way in both directions.
 */
import { describe, expect, it } from 'vitest'
import {
  CONNECTION_SORT_OPTIONS,
  defaultDirectionFor,
  describeSort,
  isConnectionSortKey,
  normaliseSortDirection,
  normaliseSortKey,
  sortConnections
} from '../../../src/renderer/src/lib/sortConnections'
import { DEFAULT_SETTINGS } from '../../../src/shared/types'
import type { SavedConnection } from '../../../src/shared/types'

interface Sample {
  name: string
  host?: string
  port?: number
  createdAt?: string
  lastUsedAt?: string
}

const connection = (sample: Sample): SavedConnection =>
  ({
    id: sample.name,
    host: 'db.internal',
    port: 1433,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...sample
  }) as SavedConnection

const names = (list: SavedConnection[]): string[] => list.map((entry) => entry.name)

describe('sorting by when it was made', () => {
  const list = [
    connection({ name: 'middle', createdAt: '2024-06-01T00:00:00.000Z' }),
    connection({ name: 'newest', createdAt: '2024-09-01T00:00:00.000Z' }),
    connection({ name: 'oldest', createdAt: '2024-01-01T00:00:00.000Z' })
  ]

  it('puts the newest first, which is what the list opens on', () => {
    expect(names(sortConnections(list, 'created', 'desc'))).toEqual([
      'newest',
      'middle',
      'oldest'
    ])
  })

  it('reads the other way round when the order is flipped', () => {
    expect(names(sortConnections(list, 'created', 'asc'))).toEqual([
      'oldest',
      'middle',
      'newest'
    ])
  })

  it('is the default the app ships with', () => {
    expect(DEFAULT_SETTINGS.connectionSort).toBe('created')
    expect(DEFAULT_SETTINGS.connectionSortDirection).toBe('desc')
  })
})

describe('sorting by name', () => {
  it('ignores case, so Staging does not sort above prod', () => {
    const list = [
      connection({ name: 'staging' }),
      connection({ name: 'Analytics' }),
      connection({ name: 'prod' })
    ]
    expect(names(sortConnections(list, 'name', 'asc'))).toEqual([
      'Analytics',
      'prod',
      'staging'
    ])
  })

  it('counts the numbers on the end rather than reading them as text', () => {
    const list = [
      connection({ name: 'shard10' }),
      connection({ name: 'shard2' }),
      connection({ name: 'shard1' })
    ]
    expect(names(sortConnections(list, 'name', 'asc'))).toEqual([
      'shard1',
      'shard2',
      'shard10'
    ])
  })
})

describe('sorting by endpoint', () => {
  it('groups one host together and orders its ports numerically', () => {
    const list = [
      connection({ name: 'b', host: 'db-a.internal', port: 1433 }),
      connection({ name: 'c', host: 'db-a.internal', port: 1401 }),
      connection({ name: 'a', host: 'analytics.internal', port: 1433 })
    ]
    expect(names(sortConnections(list, 'host', 'asc'))).toEqual(['a', 'c', 'b'])
  })
})

describe('connections that have never been opened', () => {
  const list = [
    connection({ name: 'never' }),
    connection({ name: 'recent', lastUsedAt: '2024-09-01T00:00:00.000Z' }),
    connection({ name: 'stale', lastUsedAt: '2024-02-01T00:00:00.000Z' })
  ]

  it('sit after the ones that have, whichever way the list reads', () => {
    // An absent time is not an early one: flipping the order should not lift
    // rows nobody has ever used to the top of the list.
    expect(names(sortConnections(list, 'lastUsed', 'desc'))).toEqual([
      'recent',
      'stale',
      'never'
    ])
    expect(names(sortConnections(list, 'lastUsed', 'asc'))).toEqual([
      'stale',
      'recent',
      'never'
    ])
  })

  it('are ordered among themselves by name', () => {
    const unused = [connection({ name: 'zeta' }), connection({ name: 'alpha' })]
    expect(names(sortConnections(unused, 'lastUsed', 'desc'))).toEqual(['alpha', 'zeta'])
  })
})

describe('ties', () => {
  it('fall back to the name, so flipping the order does not shuffle rows', () => {
    const made = '2024-05-05T09:00:00.000Z'
    const list = [
      connection({ name: 'charlie', createdAt: made }),
      connection({ name: 'alpha', createdAt: made }),
      connection({ name: 'bravo', createdAt: made })
    ]
    expect(names(sortConnections(list, 'created', 'desc'))).toEqual([
      'alpha',
      'bravo',
      'charlie'
    ])
    expect(names(sortConnections(list, 'created', 'asc'))).toEqual([
      'alpha',
      'bravo',
      'charlie'
    ])
  })
})

describe('the list it is handed', () => {
  it('is copied rather than reordered in place', () => {
    const list = [connection({ name: 'b' }), connection({ name: 'a' })]
    const sorted = sortConnections(list, 'name', 'asc')
    expect(names(list)).toEqual(['b', 'a'])
    expect(names(sorted)).toEqual(['a', 'b'])
  })

  it('tolerates records written before a field existed', () => {
    const list = [
      connection({ name: 'undated', createdAt: undefined }),
      connection({ name: 'dated', createdAt: '2024-04-01T00:00:00.000Z' })
    ]
    expect(names(sortConnections(list, 'created', 'desc'))).toEqual(['dated', 'undated'])
  })

  it('tolerates a createdAt that is not a date at all', () => {
    const list = [
      connection({ name: 'broken', createdAt: 'not-a-date' }),
      connection({ name: 'fine', createdAt: '2024-04-01T00:00:00.000Z' })
    ]
    expect(names(sortConnections(list, 'created', 'desc'))).toEqual(['fine', 'broken'])
  })
})

describe('the stored preference', () => {
  it('falls back to the default when the settings file holds a key this build has never heard of', () => {
    expect(normaliseSortKey('by-vibes')).toBe(DEFAULT_SETTINGS.connectionSort)
    expect(normaliseSortKey(undefined)).toBe(DEFAULT_SETTINGS.connectionSort)
    expect(normaliseSortDirection('sideways')).toBe(DEFAULT_SETTINGS.connectionSortDirection)
  })

  it('keeps a key it does know', () => {
    expect(normaliseSortKey('name')).toBe('name')
    expect(normaliseSortDirection('asc')).toBe('asc')
    expect(isConnectionSortKey('lastUsed')).toBe(true)
    expect(isConnectionSortKey('nothing')).toBe(false)
  })

  it('still sorts by something when the key is nonsense', () => {
    const list = [connection({ name: 'b' }), connection({ name: 'a' })]
    // Not a key the picker offers; the list is ordered rather than left alone.
    const sorted = sortConnections(list, 'by-vibes' as never, 'asc')
    expect(names(sorted)).toEqual(['a', 'b'])
  })
})

describe('what the picker offers', () => {
  it('covers the four keys, each opening in the direction it is read in', () => {
    expect(CONNECTION_SORT_OPTIONS.map((option) => option.key)).toEqual([
      'created',
      'name',
      'lastUsed',
      'host'
    ])
    expect(defaultDirectionFor('created')).toBe('desc')
    expect(defaultDirectionFor('lastUsed')).toBe('desc')
    expect(defaultDirectionFor('name')).toBe('asc')
    expect(defaultDirectionFor('host')).toBe('asc')
  })

  it('says which way the active order reads', () => {
    expect(describeSort('created', 'desc')).toBe('Newest first')
    expect(describeSort('created', 'asc')).toBe('Oldest first')
    expect(describeSort('name', 'asc')).toBe('A to Z')
  })
})
