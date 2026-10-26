/**
 * The activity monitor's reading of the server's sessions: blocking chains
 * with the head blocker first, and which sessions are listed.
 */
import { describe, expect, it } from 'vitest'
import {
  blockingChains,
  formatDuration,
  isActive,
  visibleSessions
} from '../../../src/renderer/src/lib/activity'
import type { ActivitySession } from '../../../src/shared/types'

function session(sessionId: number, patch: Partial<ActivitySession> = {}): ActivitySession {
  return {
    sessionId,
    login: 'app',
    host: 'web01',
    program: 'api',
    database: 'shop',
    status: 'sleeping',
    command: null,
    blockedBy: null,
    waitType: null,
    waitTimeMs: 0,
    waitResource: null,
    cpuMs: 0,
    logicalReads: 0,
    elapsedMs: null,
    openTransactions: 0,
    sql: null,
    sqlIsCurrent: false,
    loginTime: null,
    lastRequestEnd: null,
    ownProcess: false,
    ...patch
  }
}

const ids = (links: { session: ActivitySession; depth: number }[]): [number, number][] =>
  links.map((link) => [link.session.sessionId, link.depth])

describe('blockingChains', () => {
  it('has none when nobody waits on anybody', () => {
    expect(blockingChains([session(51), session(52)])).toEqual([])
  })

  it('puts the head blocker first and what waits on it under it', () => {
    const chains = blockingChains([
      session(53, { blockedBy: 52, waitTimeMs: 100 }),
      session(51, { openTransactions: 1 }),
      session(52, { blockedBy: 51, waitTimeMs: 900 }),
      session(54, { blockedBy: 51, waitTimeMs: 5000 })
    ])
    expect(chains).toHaveLength(1)
    expect(chains[0].head.sessionId).toBe(51)
    expect(chains[0].blocked).toBe(3)
    // Longest wait first among those waiting on the same session.
    expect(ids(chains[0].links)).toEqual([
      [51, 0],
      [54, 1],
      [52, 1],
      [53, 2]
    ])
  })

  it('lists separate chains biggest first', () => {
    const chains = blockingChains([
      session(60),
      session(61, { blockedBy: 60 }),
      session(70),
      session(71, { blockedBy: 70 }),
      session(72, { blockedBy: 70 })
    ])
    expect(chains.map((chain) => chain.head.sessionId)).toEqual([70, 60])
  })

  it('stands in for a blocker the login cannot see', () => {
    const [chain] = blockingChains([session(80, { blockedBy: 12 })])
    expect(chain.head).toMatchObject({ sessionId: 12, status: 'not visible' })
    expect(ids(chain.links)).toEqual([
      [12, 0],
      [80, 1]
    ])
  })

  it('does not lose sessions waiting on each other in a cycle', () => {
    const [chain] = blockingChains([session(91, { blockedBy: 92 }), session(92, { blockedBy: 91 })])
    expect(ids(chain.links)).toEqual([
      [91, 0],
      [92, 1]
    ])
  })
})

describe('visibleSessions', () => {
  const all = [
    session(51),
    session(52, { sqlIsCurrent: true, sql: 'SELECT * FROM orders' }),
    session(53, { openTransactions: 2 }),
    session(54, { blockedBy: 53, sqlIsCurrent: true, login: 'reporting' })
  ]

  it('leaves idle sessions out unless asked for', () => {
    expect(visibleSessions(all, { showIdle: false, filter: '' }).map((s) => s.sessionId)).toEqual([
      54, 52, 53
    ])
    expect(visibleSessions(all, { showIdle: true, filter: '' })).toHaveLength(4)
  })

  it('puts head blockers first, then the blocked, then the running', () => {
    const order = visibleSessions(all, { showIdle: true, filter: '', blockers: new Set([53]) })
    expect(order.map((s) => s.sessionId)).toEqual([53, 54, 52, 51])
  })

  it('filters on login, host, program, database and statement', () => {
    const match = (filter: string): number[] =>
      visibleSessions(all, { showIdle: true, filter }).map((s) => s.sessionId)
    expect(match('orders')).toEqual([52])
    expect(match('REPORT')).toEqual([54])
    expect(match('53')).toEqual([53])
  })
})

describe('isActive', () => {
  it('counts a running request, an open transaction or a wait', () => {
    expect(isActive(session(1))).toBe(false)
    expect(isActive(session(1, { sqlIsCurrent: true }))).toBe(true)
    expect(isActive(session(1, { openTransactions: 1 }))).toBe(true)
  })
})

describe('formatDuration', () => {
  it('scales the unit to the length', () => {
    expect(formatDuration(null)).toBe('')
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(12_400)).toBe('12.4 s')
    expect(formatDuration(185_000)).toBe('3 min 5 s')
    expect(formatDuration(7_440_000)).toBe('2 h 4 min')
  })
})
