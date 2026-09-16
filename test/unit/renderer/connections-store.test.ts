/**
 * Duplicating a connection, from the store's side.
 *
 * The screen opens the copy in the form the moment it exists, so the store has
 * to hand the new record back — and the list it hands back has to be the one
 * that already carries it, or saving the edits would write to a stale row.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedConnection } from '../../../src/shared/types'

const listConnections = vi.fn()
const duplicateConnection = vi.fn()

vi.mock('../../../src/renderer/src/lib/api', () => ({
  api: {
    listConnections: () => listConnections(),
    duplicateConnection: (id: string) => duplicateConnection(id)
  }
}))

const { useConnectionStore } = await import('../../../src/renderer/src/stores/connections')

const connection = (id: string, name: string): SavedConnection =>
  ({ id, name, host: 'db', port: 1433 }) as SavedConnection

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
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
