/**
 * The policy behind putting a dropped connection back.
 *
 * Two ways to get this wrong, and both are worse than the drop: give up while
 * the user is still sitting in front of the window, or keep trying forever —
 * which for an SSM connection means spawning an AWS CLI session every half
 * minute for as long as the app is open.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAYS_MS,
  isHopeless,
  planReconnect
} from '../../src/main/db/reconnect'
import { SSM_CREDENTIALS_EXPIRED } from '../../src/shared/types'

const dropped = new Error('socket hang up')

describe('planReconnect', () => {
  it('tries again almost at once after the first failure', () => {
    expect(planReconnect(1, dropped)).toEqual({ retry: true, delayMs: RECONNECT_DELAYS_MS[0] })
  })

  it('backs off with each attempt, then holds at the longest wait', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => planReconnect(attempt, dropped).delayMs)
    const last = RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]

    expect(delays.slice(0, RECONNECT_DELAYS_MS.length)).toEqual(RECONNECT_DELAYS_MS)
    // Past the end of the list the wait stops growing rather than running out.
    expect(delays.slice(RECONNECT_DELAYS_MS.length).every((delay) => delay === last)).toBe(true)
  })

  it('keeps trying for long enough to outlast a sleeping laptop', () => {
    const total = Array.from({ length: MAX_RECONNECT_ATTEMPTS }, (_, index) =>
      planReconnect(index + 1, dropped)
    )
      .filter((plan) => plan.retry)
      .reduce((sum, plan) => sum + plan.delayMs, 0)

    expect(total).toBeGreaterThan(5 * 60 * 1000)
  })

  it('stops once it has tried enough', () => {
    expect(planReconnect(MAX_RECONNECT_ATTEMPTS - 1, dropped).retry).toBe(true)
    expect(planReconnect(MAX_RECONNECT_ATTEMPTS, dropped).retry).toBe(false)
    expect(planReconnect(MAX_RECONNECT_ATTEMPTS + 5, dropped).retry).toBe(false)
  })

  it('does not retry what retrying cannot fix', () => {
    const expired = Object.assign(new Error('credentials expired'), {
      code: SSM_CREDENTIALS_EXPIRED
    })
    const refused = Object.assign(new Error('Login failed for user'), { code: 'ELOGIN' })

    expect(planReconnect(1, expired)).toEqual({ retry: false, delayMs: 0 })
    expect(planReconnect(1, refused)).toEqual({ retry: false, delayMs: 0 })
  })
})

describe('isHopeless', () => {
  it('treats a dropped socket as worth another go', () => {
    expect(isHopeless(dropped)).toBe(false)
    expect(isHopeless(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(
      false
    )
  })

  it('survives being handed something that is not an error', () => {
    expect(isHopeless(null)).toBe(false)
    expect(isHopeless(undefined)).toBe(false)
    expect(isHopeless('socket hang up')).toBe(false)
  })
})
