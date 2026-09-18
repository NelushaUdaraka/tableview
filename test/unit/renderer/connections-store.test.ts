/**
 * Duplicating a connection, and the order the list comes out in.
 *
 * The screen opens the copy in the form the moment it exists, so the store has
 * to hand the new record back — and the list it hands back has to be the one
 * that already carries it, or saving the edits would write to a stale row. The
 * order is the other half: it is a setting rather than a rule, so the store
 * reads it from there and writes the reader's choice back.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/types'
import type { AppSettings, SavedConnection } from '../../../src/shared/types'

const listConnections = vi.fn()
const duplicateConnection = vi.fn()
const getSettings = vi.fn()
const getAppInfo = vi.fn()
const updateSettings = vi.fn()

vi.mock('../../../src/renderer/src/lib/api', () => ({
  api: {
    listConnections: () => listConnections(),
    duplicateConnection: (id: string) => duplicateConnection(id),
    getSettings: () => getSettings(),
    getAppInfo: () => getAppInfo(),
    updateSettings: (patch: Partial<AppSettings>) => updateSettings(patch)
  }
}))

const { useConnectionStore } = await import('../../../src/renderer/src/stores/connections')
const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')

const connection = (id: string, name: string): SavedConnection =>
  ({ id, name, host: 'db', port: 1433 }) as SavedConnection

/** A saved connection with the two timestamps the ordering reads. */
const dated = (id: string, name: string, createdAt: string, lastUsedAt?: string): SavedConnection =>
  ({ id, name, host: 'db', port: 1433, createdAt, lastUsedAt }) as SavedConnection

/** Stands in for settings.json, which a patch is merged into rather than over. */
let stored: AppSettings

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getAppInfo.mockResolvedValue(null)
  stored = { ...DEFAULT_SETTINGS }
  getSettings.mockImplementation(async () => ({ ...stored }))
  updateSettings.mockImplementation(async (patch: Partial<AppSettings>) => {
    stored = { ...stored, ...patch }
    return { ...stored }
  })
})

describe('duplicating', () => {
  it('returns the copy and reloads the list around it', async () => {
    const copy = connection('c2', 'Prod (copy)')
    duplicateConnection.mockResolvedValue(copy)
    listConnections.mockResolvedValue([connection('c1', 'Prod'), copy])

    const store = useConnectionStore()
    const result = await store.duplicate('c1')

    expect(duplicateConnection).toHaveBeenCalledWith('c1')
    expect(result?.id).toBe('c2')
    expect(store.saved.map((entry) => entry.id)).toEqual(['c1', 'c2'])
  })

  it('reports nothing copied when the connection is no longer saved', async () => {
    duplicateConnection.mockResolvedValue(null)
    listConnections.mockResolvedValue([])

    const store = useConnectionStore()
    // Null rather than a throw: the screen says so and stays where it is.
    expect(await store.duplicate('gone')).toBeNull()
    expect(listConnections).toHaveBeenCalled()
  })

  it('leaves the open session alone', async () => {
    const copy = connection('c2', 'Prod (copy)')
    duplicateConnection.mockResolvedValue(copy)
    listConnections.mockResolvedValue([connection('c1', 'Prod'), copy])

    const store = useConnectionStore()
    store.activeId = 'c1'
    await store.duplicate('c1')

    expect(store.activeId).toBe('c1')
  })
})

describe('the order the list reads in', () => {
  const list = [
    dated('c1', 'alpha', '2024-01-01T00:00:00.000Z', '2024-09-01T00:00:00.000Z'),
    dated('c2', 'bravo', '2024-08-01T00:00:00.000Z'),
    dated('c3', 'charlie', '2024-04-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z')
  ]

  it('starts on the newest connection, before any preference is stored', async () => {
    listConnections.mockResolvedValue(list)

    const store = useConnectionStore()
    await store.load()

    expect(store.sortKey).toBe('created')
    expect(store.sortDirection).toBe('desc')
    expect(store.sorted.map((entry) => entry.name)).toEqual(['bravo', 'charlie', 'alpha'])
  })

  it('follows the preference the settings file was holding', async () => {
    listConnections.mockResolvedValue(list)
    stored = { ...stored, connectionSort: 'lastUsed', connectionSortDirection: 'desc' }

    const settings = useSettingsStore()
    const store = useConnectionStore()
    await settings.load()
    await store.load()

    // Never opened sorts last, not first, however the rest is read.
    expect(store.sorted.map((entry) => entry.name)).toEqual(['alpha', 'charlie', 'bravo'])
  })

  it('re-sorts on a new key, and opens it the way that key is read', async () => {
    listConnections.mockResolvedValue(list)

    const store = useConnectionStore()
    await store.load()
    await store.setSortKey('name')

    expect(updateSettings).toHaveBeenCalledWith({
      connectionSort: 'name',
      connectionSortDirection: 'asc'
    })
    expect(store.sorted.map((entry) => entry.name)).toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('flips the same key the other way round', async () => {
    listConnections.mockResolvedValue(list)

    const store = useConnectionStore()
    await store.load()
    await store.setSortKey('name')
    await store.toggleSortDirection()

    expect(updateSettings).toHaveBeenLastCalledWith({ connectionSortDirection: 'desc' })
    expect(store.sortKey).toBe('name')
    expect(store.sorted.map((entry) => entry.name)).toEqual(['charlie', 'bravo', 'alpha'])
  })

  it('leaves the list as it was when the preference cannot be written', async () => {
    listConnections.mockResolvedValue(list)
    updateSettings.mockRejectedValue(new Error('settings.json is read-only'))

    const store = useConnectionStore()
    await store.load()

    // The screen reports it; what it must not do is say one order and show
    // another, so the list stays on the order that is actually stored.
    await expect(store.setSortKey('name')).rejects.toThrow('read-only')
    expect(store.sortKey).toBe('created')
    expect(store.sorted.map((entry) => entry.name)).toEqual(['bravo', 'charlie', 'alpha'])
  })
})
