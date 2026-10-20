/**
 * A connection opens in the database it was last switched to, and a database
 * that can no longer be opened never stops it opening.
 */
import { describe, expect, it, vi } from 'vitest'
import { enterRememberedDatabase } from '../../src/main/db/lastDatabase'
import type { ConnectionStatus } from '../../src/shared/types'
import { DEFAULT_UI_STATE, forgetConnection, mergeUiState, normalizeUiState } from '../../src/shared/uiState'

const connected = (database: string): ConnectionStatus => ({
  connectionId: 'c1',
  state: 'connected',
  currentDatabase: database
})

describe('entering the remembered database', () => {
  it('switches once connected, and answers with where it is now', async () => {
    const useDatabase = vi.fn(async (name: string) => connected(name))
    const result = await enterRememberedDatabase(connected('shop'), 'archive', useDatabase)
    expect(useDatabase).toHaveBeenCalledWith('archive')
    expect(result).toEqual({ status: connected('archive'), forget: false })
  })

  it('does nothing with nothing remembered, the same database, or no connection', async () => {
    const useDatabase = vi.fn(async (name: string) => connected(name))
    const failed: ConnectionStatus = { connectionId: 'c1', state: 'error', error: { message: 'Login failed' } }
    for (const [status, remembered] of [
      [connected('shop'), undefined],
      [connected('shop'), ''],
      [connected('shop'), 'shop'],
      [failed, 'archive']
    ] as const) {
      expect(await enterRememberedDatabase(status, remembered, useDatabase)).toEqual({ status, forget: false })
    }
    expect(useDatabase).not.toHaveBeenCalled()
  })

  it('stays open where it is, and forgets, when the database cannot be opened', async () => {
    const useDatabase = vi.fn(async () => {
      throw new Error('Cannot open database "gone" requested by the login.')
    })
    expect(await enterRememberedDatabase(connected('shop'), 'gone', useDatabase)).toEqual({
      status: connected('shop'),
      forget: true
    })
  })
})

describe('remembered databases in the stored state', () => {
  it('merges per connection, forgets on an empty name, and drops with the connection', () => {
    let state = mergeUiState(DEFAULT_UI_STATE, { databases: { c1: 'archive' } })
    state = mergeUiState(state, { databases: { c2: 'reports' } })
    expect(state.databases).toEqual({ c1: 'archive', c2: 'reports' })
    state = mergeUiState(state, { databases: { c1: '' } })
    expect(state.databases).toEqual({ c2: 'reports' })
    expect(forgetConnection(state, 'c2').databases).toEqual({})
  })

  it('reads back only names', () => {
    expect(normalizeUiState({ databases: { c1: 'shop', c2: 7, c3: '' } }).databases).toEqual({ c1: 'shop' })
  })
})
