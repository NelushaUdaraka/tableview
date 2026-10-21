/**
 * A query tab's session: when it follows the sidebar to another database,
 * when a run after losing it may go ahead, and what the tab says about it.
 *
 * Both sides read these — the main process decides with them, the window
 * draws with them — so they are pure, and tested once here.
 */
import { describe, expect, it } from 'vitest'
import {
  canCommit,
  followDecision,
  lostSessionNote,
  lostSessionRefusal,
  refuseAfterLoss,
  sameDatabase,
  transactionAge,
  transactionOpen,
  withTransactionSince,
  type SessionPlace
} from '../../src/shared/sessions'
import type { SessionState } from '../../src/shared/types'

const state = (over: Partial<SessionState> = {}): SessionState => ({
  transactionCount: 0,
  transactionState: 0,
  database: 'sales',
  ...over
})

describe('sameDatabase', () => {
  it('compares names the way SQL Server usually does, without case', () => {
    expect(sameDatabase('Sales', 'sales')).toBe(true)
    expect(sameDatabase('sales', 'master')).toBe(false)
    expect(sameDatabase(undefined, 'sales')).toBe(false)
  })
})

describe('followDecision', () => {
  const place = (over: Partial<SessionPlace> = {}): SessionPlace => ({
    database: 'sales',
    transactionCount: 0,
    pinned: false,
    running: false,
    ...over
  })

  it('follows the sidebar from where it was', () => {
    expect(followDecision(place(), 'sales')).toBe('follow')
  })

  it('stays in a database of its own', () => {
    expect(followDecision(place({ database: 'master' }), 'sales')).toBe('stay')
  })

  it('stays in a transaction', () => {
    expect(followDecision(place({ transactionCount: 1 }), 'sales')).toBe('stay')
  })

  it('stays pinned to a routine', () => {
    expect(followDecision(place({ pinned: true }), 'sales')).toBe('stay')
  })

  it('follows later when its query is running', () => {
    expect(followDecision(place({ running: true }), 'sales')).toBe('later')
  })

  it('stays, running or not, when a transaction was already open', () => {
    expect(followDecision(place({ running: true, transactionCount: 1 }), 'sales')).toBe('stay')
  })
})

describe('refuseAfterLoss', () => {
  it('refuses when a transaction was open', () => {
    expect(refuseAfterLoss(state({ transactionCount: 1 }), 'sales')).toBe(true)
  })

  it('refuses when the session was in another database', () => {
    expect(refuseAfterLoss(state({ database: 'master' }), 'sales')).toBe(true)
  })

  it('runs on when there was nothing to lose', () => {
    expect(refuseAfterLoss(state(), 'SALES')).toBe(false)
  })
})

describe('withTransactionSince', () => {
  const now = new Date('2026-10-21T10:00:00Z')

  it('notes when a transaction opens, and keeps that time while it stays open', () => {
    const opened = withTransactionSince(null, state({ transactionCount: 1, transactionState: 1 }), now)
    expect(opened.transactionSince).toBe('2026-10-21T10:00:00.000Z')
    const later = withTransactionSince(
      opened,
      state({ transactionCount: 2, transactionState: 1 }),
      new Date('2026-10-21T10:05:00Z')
    )
    expect(later.transactionSince).toBe('2026-10-21T10:00:00.000Z')
  })

  it('forgets it once the transaction is gone', () => {
    const closed = withTransactionSince(state({ transactionCount: 1, transactionSince: 'x' }), state(), now)
    expect(closed.transactionSince).toBeUndefined()
  })
})

describe('the words', () => {
  it('says what a lost session took with it', () => {
    expect(lostSessionNote(state())).toBe(
      "This tab's session was closed — temp tables and settings from earlier runs are gone."
    )
    expect(lostSessionNote(state({ transactionCount: 1 }))).toBe(
      "This tab's session was closed — temp tables and settings from earlier runs are gone, and its open transaction was rolled back by the server."
    )
  })

  it('says nothing ran, and where the next run starts', () => {
    expect(lostSessionRefusal(state({ transactionCount: 1 }), 'sales')).toBe(
      "This tab's session was closed — temp tables and settings from earlier runs are gone, and its open transaction was rolled back by the server. Nothing was run; run again to start a new session in sales."
    )
  })

  it('gives a transaction its age', () => {
    const now = new Date('2026-10-21T11:05:30Z')
    expect(transactionAge('2026-10-21T11:05:18Z', now)).toBe('12s')
    expect(transactionAge('2026-10-21T11:01:30Z', now)).toBe('4m')
    expect(transactionAge('2026-10-21T10:00:30Z', now)).toBe('1h 5m')
    expect(transactionAge(undefined, now)).toBe('')
  })

  it('knows a transaction that can only be rolled back', () => {
    expect(transactionOpen(state({ transactionCount: 1, transactionState: 1 }))).toBe(true)
    expect(canCommit(state({ transactionCount: 1, transactionState: -1 }))).toBe(false)
    expect(canCommit(state({ transactionCount: 1, transactionState: 1 }))).toBe(true)
    expect(transactionOpen(undefined)).toBe(false)
  })
})
