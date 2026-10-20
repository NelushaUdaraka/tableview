/**
 * The remembered layout: read back forgivingly, and merged so that two windows
 * remembering different tables keep both.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppData } from '../../src/main/storage/appData'
import { LocalKeyVault } from '../../src/main/storage/crypto'
import {
  DEFAULT_UI_STATE,
  forgetConnection,
  MAX_REMEMBERED_TABLES,
  mergeUiState,
  normalizeSavedTabs,
  normalizeUiState,
  tableMemoryKey,
  type SavedTabs
} from '../../src/shared/uiState'

const orders = tableMemoryKey('c1', 'shop', 'dbo', 'Orders')
const queue = tableMemoryKey('c1', 'shop', 'dbo', 'Queue')

describe('normalizeUiState', () => {
  it('defaults everything when there is nothing stored', () => {
    expect(normalizeUiState(undefined)).toEqual(DEFAULT_UI_STATE)
    expect(normalizeUiState('nonsense')).toEqual(DEFAULT_UI_STATE)
  })

  it('keeps valid values and replaces bad ones', () => {
    const state = normalizeUiState({
      sidebarWidth: 412.6,
      sidebarCollapsed: 'yes',
      sidebarPanel: 'saved',
      queryEditorHeight: -5,
      autoRefresh: { [orders]: 5000, [queue]: 'often', other: 0 }
    })
    expect(state).toEqual({
      sidebarWidth: 413,
      sidebarCollapsed: false,
      sidebarPanel: 'saved',
      queryEditorHeight: DEFAULT_UI_STATE.queryEditorHeight,
      autoRefresh: { [orders]: 5000 },
      openTabs: {},
      databases: {}
    })
  })

  it('refuses a panel that does not exist', () => {
    expect(normalizeUiState({ sidebarPanel: 'tables' }).sidebarPanel).toBe('objects')
  })
})

describe('tableMemoryKey', () => {
  it('tells apart tables that only differ in where the dots would go', () => {
    expect(tableMemoryKey('c', 'a.b', 'c', 'd')).not.toBe(tableMemoryKey('c', 'a', 'b.c', 'd'))
  })
})

describe('mergeUiState', () => {
  it('merges tables one by one and forgets one turned off', () => {
    let state = mergeUiState(DEFAULT_UI_STATE, { autoRefresh: { [orders]: 5000 } })
    state = mergeUiState(state, { autoRefresh: { [queue]: 60000 } })
    expect(state.autoRefresh).toEqual({ [orders]: 5000, [queue]: 60000 })
    state = mergeUiState(state, { autoRefresh: { [orders]: 0 } })
    expect(state.autoRefresh).toEqual({ [queue]: 60000 })
  })

  it('changes only the fields a patch names', () => {
    const state = mergeUiState(
      { ...DEFAULT_UI_STATE, sidebarPanel: 'history', autoRefresh: { [orders]: 5000 } },
      { sidebarWidth: 280 }
    )
    expect(state).toEqual({
      ...DEFAULT_UI_STATE,
      sidebarWidth: 280,
      sidebarPanel: 'history',
      autoRefresh: { [orders]: 5000 }
    })
  })

  it('drops the tables set longest ago past the limit', () => {
    let state = DEFAULT_UI_STATE
    for (let i = 0; i < MAX_REMEMBERED_TABLES + 5; i += 1) {
      state = mergeUiState(state, { autoRefresh: { [`t${i}`]: 5000 } })
    }
    // Setting an early one again keeps it: it is now the newest.
    state = mergeUiState(state, { autoRefresh: { t5: 10000 } })
    const keys = Object.keys(state.autoRefresh)
    expect(keys).toHaveLength(MAX_REMEMBERED_TABLES)
    expect(keys.at(-1)).toBe('t5')
    expect(keys).not.toContain('t4')
    expect(keys).toContain('t6')
  })
})

describe('AppData ui state', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('forgets a connection’s layout when the connection is deleted', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-uistate-'))
    const appData = new AppData(dir, new LocalKeyVault(path.join(dir, 'secret.key')))
    const connection = appData.saveConnection({ name: 'Gone', host: 'h', port: 1433 })
    appData.updateUiState({
      autoRefresh: { [tableMemoryKey(connection.id, 'shop', 'dbo', 'Orders')]: 5000 },
      openTabs: { [connection.id]: { panes: [{ tabs: [{ kind: 'query', title: 'Q', sql: '' }], active: 0 }], focused: 0 } }
    })
    appData.deleteConnection(connection.id)
    expect(appData.getUiState()).toEqual(DEFAULT_UI_STATE)
  })

  it('keeps no tabs once reopening them is turned off', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-uistate-'))
    const appData = new AppData(dir, new LocalKeyVault(path.join(dir, 'secret.key')))
    const tabs: SavedTabs = { panes: [{ tabs: [{ kind: 'query', title: 'Q', sql: '' }], active: 0 }], focused: 0 }
    appData.updateUiState({ sidebarWidth: 250, openTabs: { c1: tabs } })
    appData.updateSettings({ restoreTabs: false })
    expect(appData.getUiState().openTabs).toEqual({})
    expect(appData.getUiState().sidebarWidth).toBe(250)
    // A write sent before the switch was flipped lands after it: still nothing kept.
    appData.updateUiState({ openTabs: { c1: tabs } })
    expect(appData.getUiState().openTabs).toEqual({})
    appData.updateSettings({ restoreTabs: true })
    appData.updateUiState({ openTabs: { c1: tabs } })
    expect(Object.keys(appData.getUiState().openTabs)).toEqual(['c1'])
  })

  it('survives a restart', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-uistate-'))
    const vault = new LocalKeyVault(path.join(dir, 'secret.key'))
    new AppData(dir, vault).updateUiState({ sidebarWidth: 260, autoRefresh: { [orders]: 30000 } })
    new AppData(dir, vault).updateUiState({ autoRefresh: { [queue]: 5000 } })
    expect(new AppData(dir, vault).getUiState()).toEqual({
      ...DEFAULT_UI_STATE,
      sidebarWidth: 260,
      autoRefresh: { [orders]: 30000, [queue]: 5000 }
    })
  })
})

describe('saved tabs', () => {
  const saved: SavedTabs = {
    panes: [{ tabs: [{ kind: 'query', title: 'Q', sql: 'SELECT 1' }], active: 0 }],
    focused: 0
  }

  it('keeps one connection’s tabs apart from another’s, and forgets on null', () => {
    let state = mergeUiState(DEFAULT_UI_STATE, { openTabs: { c1: saved } })
    state = mergeUiState(state, { openTabs: { c2: saved } })
    expect(Object.keys(state.openTabs)).toEqual(['c1', 'c2'])
    state = mergeUiState(state, { openTabs: { c1: null } })
    expect(Object.keys(state.openTabs)).toEqual(['c2'])
  })

  it('reads back forgivingly: broken tabs drop, empty panes go, indexes stay in range', () => {
    expect(
      normalizeSavedTabs({
        panes: [
          { tabs: [{ kind: 'table', schema: 'dbo' }, { kind: 'nonsense' }], active: 0 },
          {
            tabs: [
              { kind: 'table', schema: 'dbo', table: 'orders', view: 'weird' },
              { kind: 'query', sql: 'SELECT 1', cursor: -4, routine: { name: 'x' } }
            ],
            active: 9
          }
        ],
        focused: 5
      })
    ).toEqual({
      panes: [
        {
          tabs: [
            { kind: 'table', title: 'orders', schema: 'dbo', table: 'orders', view: 'data' },
            { kind: 'query', title: 'Query', sql: 'SELECT 1' }
          ],
          active: 1
        }
      ],
      focused: 0
    })
    expect(normalizeSavedTabs({ panes: [] })).toBeNull()
    expect(normalizeSavedTabs('x')).toBeNull()
  })

  it('forgets a deleted connection’s tabs and table intervals, and no one else’s', () => {
    const state = forgetConnection(
      {
        ...DEFAULT_UI_STATE,
        autoRefresh: { [orders]: 5000, [tableMemoryKey('c10', 'shop', 'dbo', 'Orders')]: 5000 },
        openTabs: { c1: normalizeSavedTabs(saved)!, c10: normalizeSavedTabs(saved)! }
      },
      'c1'
    )
    expect(Object.keys(state.openTabs)).toEqual(['c10'])
    expect(Object.values(state.autoRefresh)).toHaveLength(1)
    expect(state.autoRefresh[orders]).toBeUndefined()
  })
})
