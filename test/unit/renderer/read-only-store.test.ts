/**
 * Asking before a connection comes out of read-only.
 *
 * Turning read-only on only ever makes a connection safer, so it happens at
 * once; turning it off is the moment the window starts writing to whatever the
 * connection points at, so it waits for a yes. Every toggle — the status bar,
 * the list's menu, the form — goes through here, so they all ask the same way.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedConnection } from '../../../src/shared/types'

const saveConnection = vi.fn()
const listConnections = vi.fn()

vi.mock('../../../src/renderer/src/lib/api', () => ({
  api: {
    saveConnection: (input: unknown) => saveConnection(input),
    listConnections: () => listConnections(),
    getSettings: async () => ({}),
    getAppInfo: async () => null,
    updateSettings: async () => ({})
  }
}))

const { useReadOnlyStore } = await import('../../../src/renderer/src/stores/readOnly')

const prod = { id: 'c1', name: 'Prod', host: 'db', port: 1433, readOnly: true } as SavedConnection
const dev = { id: 'c2', name: 'Dev', host: 'db', port: 1433, readOnly: true } as SavedConnection

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  listConnections.mockResolvedValue([prod])
  saveConnection.mockImplementation(async (input: { readOnly: boolean }) => ({
    ...prod,
    readOnly: input.readOnly
  }))
})

describe('switching read-only', () => {
  it('turns it on without asking', async () => {
    const store = useReadOnlyStore()
    expect(await store.setReadOnly({ ...prod, readOnly: false }, true)).toBe(true)
    expect(store.prompt).toBeNull()
    expect(saveConnection).toHaveBeenCalledWith({
      id: 'c1',
      name: 'Prod',
      readOnly: true,
      confirmWrites: false
    })
  })

  it('asks before turning it off, and leaves it on when the answer is no', async () => {
    const store = useReadOnlyStore()
    const switching = store.setReadOnly(prod, false)
    expect(store.prompt?.connection.id).toBe('c1')

    store.answer(false)
    expect(await switching).toBe(false)
    expect(store.prompt).toBeNull()
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it('turns it off once the answer is yes', async () => {
    const store = useReadOnlyStore()
    const switching = store.setReadOnly(prod, false)
    store.answer(true)

    expect(await switching).toBe(true)
    expect(saveConnection).toHaveBeenCalledWith({
      id: 'c1',
      name: 'Prod',
      readOnly: false,
      confirmWrites: false
    })
  })

  it('withdraws a question nobody answered when another is asked', async () => {
    const store = useReadOnlyStore()
    const first = store.confirmWritable(prod)
    const second = store.confirmWritable(dev)

    expect(await first).toBe(false)
    expect(store.prompt?.connection.id).toBe('c2')
    store.answer(true)
    expect(await second).toBe(true)
  })

  it('says so, and changes nothing, when the save fails', async () => {
    saveConnection.mockRejectedValue(new Error('connections.json is read-only'))
    const store = useReadOnlyStore()
    expect(await store.setReadOnly({ ...prod, readOnly: false }, true)).toBe(false)
  })
})

describe('switching confirm writes', () => {
  const confirming = { ...prod, readOnly: false, confirmWrites: true } as SavedConnection

  it('turns read-only off without asking when writes will still be confirmed', async () => {
    const store = useReadOnlyStore()
    expect(await store.setReadOnly({ ...prod, confirmWrites: true }, false)).toBe(true)
    expect(store.prompt).toBeNull()
    expect(saveConnection).toHaveBeenCalledWith({
      id: 'c1',
      name: 'Prod',
      readOnly: false,
      confirmWrites: true
    })
  })

  it('turns it on without asking', async () => {
    const store = useReadOnlyStore()
    expect(await store.setConfirmWrites({ ...prod, readOnly: false }, true)).toBe(true)
    expect(store.prompt).toBeNull()
  })

  it('asks before turning it off, naming what it leaves', async () => {
    const store = useReadOnlyStore()
    const switching = store.setConfirmWrites(confirming, false)
    expect(store.prompt?.from).toBe('confirm')

    store.answer(false)
    expect(await switching).toBe(false)
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it('does not ask to turn it off behind read-only, which still refuses everything', async () => {
    const store = useReadOnlyStore()
    expect(await store.setConfirmWrites({ ...prod, confirmWrites: true }, false)).toBe(true)
    expect(store.prompt).toBeNull()
    expect(saveConnection).toHaveBeenCalledWith({
      id: 'c1',
      name: 'Prod',
      readOnly: true,
      confirmWrites: false
    })
  })
})
