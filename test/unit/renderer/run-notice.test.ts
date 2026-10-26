/**
 * The notification a long query sends when it finishes in the background:
 * only for a slow run in a window that is not in front, saying which tab,
 * how long, and how many rows came back or what went wrong.
 */
import { describe, expect, it } from 'vitest'
import { formatElapsed, runNotice, shouldNotify } from '../../../src/renderer/src/lib/runNotice'
import type { QueryExecutionResult, StatementResult } from '../../../src/shared/types'

const ON = { notifyLongQueries: true, notifyAfterSeconds: 10 }

function statement(patch: Partial<StatementResult> = {}): StatementResult {
  return { sql: 'SELECT 1', resultSets: [], rowsAffected: [], messages: [], durationMs: 0, ...patch }
}

function result(statements: StatementResult[], cancelled = false): QueryExecutionResult {
  return { executionId: 'x', statements, totalDurationMs: 0, cancelled }
}

const set = (rowCount: number) => ({ columns: [], rows: [], rowCount, truncated: false })

describe('shouldNotify', () => {
  it('notifies for a slow run in a window that is not focused', () => {
    expect(shouldNotify({ elapsedMs: 12_000 }, false, ON)).toBe(true)
  })

  it('stays quiet for a quick run, a focused window, or the setting off', () => {
    expect(shouldNotify({ elapsedMs: 9_999 }, false, ON)).toBe(false)
    expect(shouldNotify({ elapsedMs: 60_000 }, true, ON)).toBe(false)
    expect(shouldNotify({ elapsedMs: 60_000 }, false, { ...ON, notifyLongQueries: false })).toBe(
      false
    )
  })

  it('stays quiet for a run that was cancelled', () => {
    expect(shouldNotify({ elapsedMs: 60_000, result: result([], true) }, false, ON)).toBe(false)
  })

  it('takes a threshold of nothing as one second, not every run', () => {
    expect(shouldNotify({ elapsedMs: 500 }, false, { ...ON, notifyAfterSeconds: 0 })).toBe(false)
    expect(shouldNotify({ elapsedMs: 1_000 }, false, { ...ON, notifyAfterSeconds: 0 })).toBe(true)
  })
})

describe('formatElapsed', () => {
  it('reads like a person would say it', () => {
    expect(formatElapsed(14_200)).toBe('14 s')
    expect(formatElapsed(125_000)).toBe('2 min 5 s')
    expect(formatElapsed(120_000)).toBe('2 min')
    expect(formatElapsed(3_780_000)).toBe('1 h 3 min')
    expect(formatElapsed(7_200_000)).toBe('2 h')
  })
})

describe('runNotice', () => {
  it('counts the rows that came back', () => {
    const notice = runNotice('Monthly report', {
      elapsedMs: 72_000,
      result: result([statement({ resultSets: [set(1204)] })])
    })
    expect(notice).toEqual({
      title: 'Monthly report finished',
      body: 'Finished in 1 min 12 s · 1,204 rows'
    })
  })

  it('says how many results the rows are in when there are several', () => {
    const notice = runNotice('Q', {
      elapsedMs: 11_000,
      result: result([statement({ resultSets: [set(1), set(2)] })])
    })
    expect(notice.body).toBe('Finished in 11 s · 3 rows in 2 results')
  })

  it('counts rows affected when nothing came back', () => {
    const notice = runNotice('Migration', {
      elapsedMs: 30_000,
      result: result([statement({ rowsAffected: [10, 1] })])
    })
    expect(notice.body).toBe('Finished in 30 s · 11 rows affected')
  })

  it('says what failed, shortened to its first line', () => {
    const long = 'x'.repeat(300)
    const notice = runNotice('Q', {
      elapsedMs: 15_000,
      result: result([
        statement({ error: { message: `Invalid object name 'dbo.nope'.\nmore` } })
      ])
    })
    expect(notice).toEqual({
      title: 'Q failed',
      body: "Failed after 15 s: Invalid object name 'dbo.nope'."
    })
    const shortened = runNotice('Q', { elapsedMs: 15_000, error: long }).body
    expect(shortened.endsWith('…')).toBe(true)
    expect(shortened.length).toBeLessThan(170)
  })

  it('says just how long when there is nothing to count', () => {
    expect(runNotice('Q', { elapsedMs: 20_000, result: result([statement()]) }).body).toBe(
      'Finished in 20 s'
    )
  })
})
