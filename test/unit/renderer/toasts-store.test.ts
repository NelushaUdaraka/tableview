/**
 * Toasts that come and go, and toasts that offer something to do.
 *
 * A notice fades on its own, and so does an error, given longer to be read.
 * While the pointer rests on a toast none of them goes, so the column does not
 * move under it, and once it leaves they count down again from the start. One
 * carrying an action — restart into an update, download one — stays until it
 * is taken up or dismissed, since a button that disappears before it can be
 * reached is no button at all.
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

const messages = (toasts: ReturnType<typeof useToastStore>): string[] =>
  toasts.toasts.map((toast) => toast.message)

describe('toasts', () => {
  it('lets a plain notice fade on its own', () => {
    const toasts = useToastStore()
    toasts.info('Saved')
    vi.advanceTimersByTime(5_000)
    expect(toasts.toasts).toEqual([])
  })

  it('lets an error fade too, given longer than a notice to be read', () => {
    const toasts = useToastStore()
    toasts.error('Query failed', "Invalid object name 'dbo.no_such_table'.")
    vi.advanceTimersByTime(5_000)
    expect(messages(toasts)).toEqual(['Query failed'])
    vi.advanceTimersByTime(3_000)
    expect(toasts.toasts).toEqual([])
  })

  it('keeps every toast while the pointer rests on one, so none moves out from under it', () => {
    const toasts = useToastStore()
    const saved = toasts.info('Saved')
    toasts.error('Query failed')
    toasts.hold(saved)
    vi.advanceTimersByTime(60_000)
    expect(messages(toasts)).toEqual(['Saved', 'Query failed'])
  })

  it('counts down again from the start once the pointer leaves', () => {
    const toasts = useToastStore()
    const saved = toasts.info('Saved')
    vi.advanceTimersByTime(3_000)
    toasts.hold(saved)
    vi.advanceTimersByTime(60_000)
    toasts.release(saved)
    vi.advanceTimersByTime(3_900)
    expect(messages(toasts)).toEqual(['Saved'])
    vi.advanceTimersByTime(200)
    expect(toasts.toasts).toEqual([])
  })

  it('holds a toast that arrives while the pointer is on another', () => {
    const toasts = useToastStore()
    const saved = toasts.info('Saved')
    toasts.hold(saved)
    toasts.info('Schema refreshed')
    vi.advanceTimersByTime(60_000)
    expect(messages(toasts)).toEqual(['Saved', 'Schema refreshed'])
    toasts.release(saved)
    vi.advanceTimersByTime(4_100)
    expect(toasts.toasts).toEqual([])
  })

  // A toast taken away from under the pointer never hears the pointer leave,
  // so its going has to let the rest go too, or none would close again.
  it('lets the rest count down once the toast under the pointer is dismissed', () => {
    const toasts = useToastStore()
    const saved = toasts.info('Saved')
    toasts.info('Schema refreshed')
    toasts.hold(saved)
    toasts.dismiss(saved)
    vi.advanceTimersByTime(4_100)
    expect(toasts.toasts).toEqual([])
  })

  it('ignores a leave from a toast already gone, holding for the one now under the pointer', () => {
    const toasts = useToastStore()
    const saved = toasts.info('Saved')
    const refreshed = toasts.info('Schema refreshed')
    toasts.hold(saved)
    toasts.dismiss(saved)
    toasts.hold(refreshed)
    toasts.release(saved)
    vi.advanceTimersByTime(60_000)
    expect(messages(toasts)).toEqual(['Schema refreshed'])
  })

  it('keeps a notice with something to do after the pointer has come and gone', () => {
    const toasts = useToastStore()
    const id = toasts.push('info', 'TableView 0.2.0 is ready to install', undefined, {
      action: { label: 'Restart', run: () => undefined }
    })
    toasts.hold(id)
    toasts.release(id)
    vi.advanceTimersByTime(60 * 60_000)
    expect(messages(toasts)).toEqual(['TableView 0.2.0 is ready to install'])
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
