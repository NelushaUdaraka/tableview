/**
 * A table re-reading itself on a timer.
 *
 * Off by default, timed from the end of each read so a slow table is never
 * asked twice at once, held back while the rows are being worked on, and
 * stopped — not retried every few seconds — by a read that fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_REFRESH_CHOICES,
  autoRefreshChoice,
  autoRefreshHold,
  createAutoRefresher,
  type AutoRefreshConditions
} from '../../../src/renderer/src/lib/autoRefresh'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A refresher over a fake read that takes `readMs` and answers `ok`. */
function harness(readMs = 0) {
  const state = { held: false, ok: true, reads: 0, failures: 0, inFlight: 0, overlapped: false }
  const refresher = createAutoRefresher({
    hold: () => state.held,
    refresh: async () => {
      state.reads += 1
      state.inFlight += 1
      if (state.inFlight > 1) state.overlapped = true
      // A timer of 0 is still a millisecond, as Node's own is; an instant read
      // must not take one, or every interval after it drifts.
      if (readMs > 0) await new Promise((resolve) => setTimeout(resolve, readMs))
      else await Promise.resolve()
      state.inFlight -= 1
      return state.ok
    },
    onFailure: () => {
      state.failures += 1
    }
  })
  return { state, refresher }
}

describe('the choices', () => {
  it('start with off, and offer a fixed few intervals', () => {
    expect(AUTO_REFRESH_CHOICES[0]).toEqual({ ms: 0, label: 'Off', short: 'Off' })
    expect(AUTO_REFRESH_CHOICES.map((choice) => choice.short)).toEqual([
      'Off',
      '5s',
      '10s',
      '30s',
      '1m',
      '5m',
      '15m'
    ])
  })

  it('describe an interval that is not one of them in seconds', () => {
    expect(autoRefreshChoice(30_000).label).toBe('Every 30 seconds')
    expect(autoRefreshChoice(45_000)).toEqual({
      ms: 45_000,
      label: 'Every 45 seconds',
      short: '45s'
    })
  })
})

describe('createAutoRefresher', () => {
  it('reads nothing until it is given an interval', async () => {
    const { state, refresher } = harness()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.reads).toBe(0)
    expect(refresher.interval).toBe(0)
  })

  it('reads once per interval', async () => {
    const { state, refresher } = harness()
    refresher.set(5_000)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(state.reads).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(state.reads).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(state.reads).toBe(3)
  })

  it('reads straight away when asked to, then keeps to the interval', async () => {
    const { state, refresher } = harness()
    refresher.set(5_000, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.reads).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(state.reads).toBe(2)
  })

  it('times the next read from the end of the last, so reads never overlap', async () => {
    // Each read takes longer than the interval it is meant to run at.
    const { state, refresher } = harness(8_000)
    refresher.set(5_000)
    await vi.advanceTimersByTimeAsync(5_000) // first read starts
    await vi.advanceTimersByTimeAsync(8_000) // and ends; the next is 5s away
    expect(state.reads).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(state.reads).toBe(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(state.overlapped).toBe(false)
  })

  it('lets a turn pass while something holds it, and reads on the next', async () => {
    const { state, refresher } = harness()
    refresher.set(5_000)
    state.held = true
    await vi.advanceTimersByTimeAsync(15_000)
    expect(state.reads).toBe(0)
    state.held = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(state.reads).toBe(1)
  })

  it('stops at the first failure and says so, rather than retrying', async () => {
    const { state, refresher } = harness()
    refresher.set(5_000)
    state.ok = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(state.failures).toBe(1)
    expect(refresher.interval).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.reads).toBe(1)
  })

  it('stops when set to off, including after a read already under way', async () => {
    const { state, refresher } = harness(2_000)
    refresher.set(5_000)
    await vi.advanceTimersByTimeAsync(5_000) // a read starts
    refresher.set(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.reads).toBe(1)
  })

  it('moves to a new interval without keeping the old timer', async () => {
    const { state, refresher } = harness()
    refresher.set(60_000)
    await vi.advanceTimersByTimeAsync(30_000)
    refresher.set(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(state.reads).toBe(1)
    // The minute-long timer from before would have fired by now.
    await vi.advanceTimersByTimeAsync(25_000)
    expect(state.reads).toBe(6)
  })

  it('does nothing more once disposed', async () => {
    const { state, refresher } = harness()
    refresher.set(5_000)
    refresher.dispose()
    refresher.now()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.reads).toBe(0)
  })

  it('reads now on request, and only when it is on', async () => {
    const { state, refresher } = harness()
    refresher.now()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.reads).toBe(0)
    refresher.set(60_000)
    refresher.now()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.reads).toBe(1)
  })
})

describe('autoRefreshHold', () => {
  const clear: AutoRefreshConditions = {
    connected: true,
    stagedEdits: 0,
    editing: false,
    busy: false,
    hidden: false
  }

  it('lets a read through when nothing is in the way', () => {
    expect(autoRefreshHold(clear)).toBeNull()
  })

  it('holds for staged edits, which are keyed by the row they sit in', () => {
    expect(autoRefreshHold({ ...clear, stagedEdits: 2 })).toBe('staged')
  })

  it('holds for a cell being typed into, a read under way, and a hidden window', () => {
    expect(autoRefreshHold({ ...clear, editing: true })).toBe('editing')
    expect(autoRefreshHold({ ...clear, busy: true })).toBe('busy')
    expect(autoRefreshHold({ ...clear, hidden: true })).toBe('hidden')
  })

  it('holds while the connection is down, whatever else is true', () => {
    expect(autoRefreshHold({ ...clear, connected: false, stagedEdits: 3 })).toBe('offline')
  })
})
