/**
 * Toasts that come and go, and toasts that offer something to do.
 *
 * A notice fades on its own; one carrying an action — restart into an update,
 * download one — stays until it is taken up or dismissed, since a button that
 * disappears before it can be reached is no button at all.
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '../../../src/renderer/src/stores/toasts'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('toasts', () => {
  it('lets a plain notice fade on its own', () => {
    const toasts = useToastStore()
    toasts.info('Saved')
    vi.advanceTimersByTime(5_000)
    expect(toasts.toasts).toEqual([])
  })

  it('keeps a notice with something to do until it is dismissed', () => {
    const toasts = useToastStore()
    toasts.push('info', 'TableView 0.2.0 is ready to install', undefined, {
      action: { label: 'Restart', run: () => undefined }
    })
    vi.advanceTimersByTime(60 * 60_000)
    expect(toasts.toasts.map((toast) => toast.message)).toEqual(['TableView 0.2.0 is ready to install'])
  })

  it('does what the notice offers, and puts it away', () => {
    const toasts = useToastStore()
    const run = vi.fn()
    const id = toasts.push('info', 'TableView 0.2.0 is ready to install', undefined, {
      action: { label: 'Restart', run }
    })

    toasts.act(id)
    expect(run).toHaveBeenCalledTimes(1)
    expect(toasts.toasts).toEqual([])

    // Gone already: a second click does nothing a second time.
    toasts.act(id)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
