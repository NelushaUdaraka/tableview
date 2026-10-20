/**
 * A window's side of the remembered layout: changes show at once, and reach
 * the disk together once they settle.
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_UI_STATE } from '../../../src/shared/uiState'

const getUiState = vi.fn()
const updateUiState = vi.fn()

vi.mock('../../../src/renderer/src/lib/api', () => ({
  api: {
    getUiState: () => getUiState(),
    updateUiState: (patch: unknown) => updateUiState(patch)
  }
}))

const { useUiStateStore, REMEMBER_DELAY_MS } = await import(
  '../../../src/renderer/src/stores/uiState'
)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  getUiState.mockReset()
  updateUiState.mockReset().mockResolvedValue(DEFAULT_UI_STATE)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ui state store', () => {
  it('opens with what was stored', async () => {
    getUiState.mockResolvedValue({ ...DEFAULT_UI_STATE, sidebarWidth: 250 })
    const store = useUiStateStore()
    await store.load()
    expect(store.state.sidebarWidth).toBe(250)
  })

  it('writes a drag once, where it came to rest', () => {
    const store = useUiStateStore()
    for (const width of [300, 290, 280]) store.remember({ sidebarWidth: width })
    expect(store.state.sidebarWidth).toBe(280)
    expect(updateUiState).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REMEMBER_DELAY_MS)
    expect(updateUiState).toHaveBeenCalledTimes(1)
    expect(updateUiState).toHaveBeenCalledWith({ sidebarWidth: 280 })
  })

  it('gathers several changes, tables included, into one write', () => {
    const store = useUiStateStore()
    store.rememberAutoRefresh('c1', 'shop', 'dbo', 'Orders', 5000)
    store.remember({ sidebarPanel: 'history' })
    store.rememberAutoRefresh('c1', 'shop', 'dbo', 'Queue', 60000)
    store.flush()
    expect(updateUiState).toHaveBeenCalledTimes(1)
    const patch = updateUiState.mock.calls[0][0]
    expect(patch.sidebarPanel).toBe('history')
    expect(Object.values(patch.autoRefresh)).toEqual([5000, 60000])
    expect(store.autoRefreshFor('c1', 'shop', 'dbo', 'Orders')).toBe(5000)
    expect(store.autoRefreshFor('c1', 'other', 'dbo', 'Orders')).toBe(0)
  })

  it('sends nothing when nothing changed', () => {
    useUiStateStore().flush()
    expect(updateUiState).not.toHaveBeenCalled()
  })
})
