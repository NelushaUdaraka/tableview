/**
 * The one thing the Settings dialog offers to do about updating.
 *
 * Getting it wrong is offering a restart with nothing to install, offering the
 * portable app an install it cannot do, or leaving a found update with no way
 * to fetch it.
 */
import { describe, expect, it } from 'vitest'
import { nextUpdateAction, updateInProgress } from '../../../src/renderer/src/lib/updateStatus'
import type { UpdateState } from '../../../src/shared/updates'

describe('nextUpdateAction', () => {
  it.each<[string, UpdateState, ReturnType<typeof nextUpdateAction>]>([
    ['nothing looked for yet', { mode: 'self', status: 'idle' }, 'check'],
    ['up to date', { mode: 'self', status: 'up-to-date', checkedAt: '2026-10-19T09:00:00.000Z' }, 'check'],
    ['a failed check', { mode: 'notify', status: 'error', error: 'Could not reach GitHub.' }, 'check'],
    ['an update ready to install', { mode: 'self', status: 'ready', version: '0.2.0' }, 'restart'],
    ['a restart into the update under way', { mode: 'self', status: 'installing', version: '0.2.0' }, null],
    ['an update found but not fetched', { mode: 'self', status: 'available', version: '0.2.0' }, 'get'],
    ['a copy that cannot replace itself, with a newer release out', { mode: 'notify', status: 'available', version: '0.2.0' }, 'download'],
    ['a copy that does not update itself', { mode: 'unsupported', status: 'idle' }, null]
  ])('offers the right step for %s', (_case, state, expected) => {
    expect(nextUpdateAction(state)).toBe(expected)
  })
})

describe('updateInProgress', () => {
  it('holds the button while a check or a download is under way', () => {
    expect(updateInProgress({ mode: 'self', status: 'checking' })).toBe(true)
    expect(updateInProgress({ mode: 'self', status: 'downloading', version: '0.2.0', percent: 12 })).toBe(true)
    expect(updateInProgress({ mode: 'self', status: 'ready', version: '0.2.0' })).toBe(false)
    expect(updateInProgress({ mode: 'self', status: 'error', error: 'x' })).toBe(false)
  })
})
