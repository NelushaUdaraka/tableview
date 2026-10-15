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
import type { AppSettings, ConnectionStatus, SavedConnection } from '../../../src/shared/types'

const listConnections = vi.fn()
const duplicateConnection = vi.fn()
const getSettings = vi.fn()
const getAppInfo = vi.fn()
const updateSettings = vi.fn()
const connect = vi.fn()
const saveConnection = vi.fn()

vi.mock('../../../src/renderer/src/lib/api', () => ({
  api: {
    connect: (id: string, password?: string) => connect(id, password),
    saveConnection: (input: unknown) => saveConnection(input),
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

/**
 * Whether the open connection refuses writes.
 *
 * The window takes it from the main process's word on the open connection,
 * which is what is enforced, rather than from the saved list, which another
 * window can change underneath it. A status about the connection coming or
 * going does not say; the open connection is still what it last said it was.
 */
describe('read-only', () => {
  const opened = (readOnly: boolean): ConnectionStatus => ({
    connectionId: 'c1',
    state: 'connected',
    readOnly
  })

  beforeEach(() => {
    listConnections.mockResolvedValue([{ ...connection('c1', 'Prod'), readOnly: false }])
  })

  it('is what the main process says the open connection is', async () => {
    connect.mockResolvedValue(opened(true))
    const store = useConnectionStore()
    await store.connect('c1')

    // The saved list says otherwise; the open connection is what counts.
    expect(store.active?.readOnly).toBe(false)
    expect(store.readOnly).toBe(true)
  })

  it('is not, for a writable connection', async () => {
    connect.mockResolvedValue(opened(false))
    const store = useConnectionStore()
    await store.connect('c1')
    expect(store.readOnly).toBe(false)
  })

  it('stays read-only while a dropped connection is put back', async () => {
    connect.mockResolvedValue(opened(true))
    const store = useConnectionStore()
    await store.connect('c1')

    store.setStatus({ connectionId: 'c1', state: 'connecting', error: { message: 'socket hang up' } })
    expect(store.readOnly).toBe(true)
    store.setStatus({ connectionId: 'c1', state: 'disconnected', error: { message: 'gone' } })
    expect(store.readOnly).toBe(true)
  })

  it('stays read-only through a reconnect, and after one that fails', async () => {
    connect.mockResolvedValueOnce(opened(true))
    const store = useConnectionStore()
    await store.connect('c1')

    let finish: (status: ConnectionStatus) => void = () => undefined
    connect.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    const reconnecting = store.reconnect()
    expect(store.readOnly).toBe(true)

    finish({ connectionId: 'c1', state: 'error', error: { message: 'refused' } })
    await reconnecting
    expect(store.readOnly).toBe(true)
  })
})

/**
 * Switching read-only from a quick toggle rather than the form.
 *
 * A partial save, like a move between groups, so nothing else about the
 * connection is touched — and the open connection's lock follows at once
 * rather than waiting on the status the main process sends after it.
 */
describe('switching read-only', () => {
  beforeEach(() => {
    listConnections.mockResolvedValue([{ ...connection('c1', 'Prod'), readOnly: true }])
    saveConnection.mockImplementation(async (input: { readOnly: boolean }) => ({
      ...connection('c1', 'Prod'),
      readOnly: input.readOnly
    }))
  })

  it('saves the setting alone', async () => {
    const store = useConnectionStore()
    await store.load()
    await store.setReadOnly(store.saved[0], false)
    expect(saveConnection).toHaveBeenCalledWith({ id: 'c1', name: 'Prod', readOnly: false })
  })

  it('unlocks the open connection straight away', async () => {
    connect.mockResolvedValue({ connectionId: 'c1', state: 'connected', readOnly: true })
    const store = useConnectionStore()
    await store.connect('c1')

    await store.setReadOnly(store.saved[0], false)
    expect(store.readOnly).toBe(false)
    expect(store.activeStatus?.state).toBe('connected')
  })

  it('leaves the open connection alone when another one is switched', async () => {
    connect.mockResolvedValue({ connectionId: 'c1', state: 'connected', readOnly: true })
    const store = useConnectionStore()
    await store.connect('c1')

    await store.setReadOnly({ ...connection('c2', 'Dev'), readOnly: true }, false)
    expect(store.readOnly).toBe(true)
  })
})
