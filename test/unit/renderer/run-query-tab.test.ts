/**
 * Running a query tab, from its view or from anywhere else — which is what
 * the close prompt's Save does for a routine's tab that is not on screen.
 *
 * What it resolves to is whether the routine was saved: the whole script
 * ran, and every batch of it went through. That decides both where the
 * change marks are measured from and whether the tab may then close, so a
 * selection, a failure or a cancel must never pass for a save.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryExecutionResult, RunQueryRequest } from '../../../src/shared/types'

const runQuery = vi.fn<(request: RunQueryRequest) => Promise<QueryExecutionResult>>()

vi.mock('../../../src/renderer/src/lib/api', () => ({
  api: {
    runQuery: (request: RunQueryRequest) => runQuery(request),
    listHistory: async () => []
  }
}))

const { runQueryTab } = await import('../../../src/renderer/src/lib/runQueryTab')
const { useTabStore } = await import('../../../src/renderer/src/stores/tabs')
const { useToastStore } = await import('../../../src/renderer/src/stores/toasts')
type QueryTab = import('../../../src/renderer/src/stores/tabs').QueryTab

const STORED = 'CREATE OR ALTER PROCEDURE dbo.usp_orders AS\nSELECT 1'
const EDITED = 'CREATE OR ALTER PROCEDURE dbo.usp_orders AS\nSELECT 2\n'

function answer(
  over: { error?: string; cancelled?: boolean; statements?: number } = {}
): QueryExecutionResult {
  const count = over.statements ?? 1
  return {
    executionId: 'exec',
    cancelled: over.cancelled ?? false,
    totalDurationMs: 3,
    statements: Array.from({ length: count }, (_, index) => ({
      sql: `batch ${index}`,
      resultSets: [],
      rowsAffected: [],
      messages: [],
      durationMs: 1,
      ...(over.error && index === count - 1 ? { error: { message: over.error } } : {})
    }))
  }
}

async function routineTab(): Promise<{ tabs: ReturnType<typeof useTabStore>; id: string }> {
  const tabs = useTabStore()
  await tabs.openRoutine('c1', { schema: 'dbo', name: 'usp_orders', baseline: STORED })
  const id = tabs.activeId!
  tabs.update<QueryTab>(id, { sql: EDITED })
  return { tabs, id }
}

const tab = (tabs: ReturnType<typeof useTabStore>, id: string): QueryTab =>
  tabs.tabs.find((entry) => entry.id === id) as QueryTab

beforeEach(() => {
  setActivePinia(createPinia())
  runQuery.mockReset()
})

describe('runQueryTab', () => {
  it('saves a routine run in full without an error, and measures from what ran', async () => {
    const { tabs, id } = await routineTab()
    runQuery.mockResolvedValue(answer())

    expect(await runQueryTab(id)).toBe(true)
    // The trimmed script is what is sent; the tab's own text is the baseline.
    expect(runQuery.mock.calls[0][0]).toMatchObject({ connectionId: 'c1', sql: EDITED.trim() })
    expect(tab(tabs, id).routine?.baseline).toBe(EDITED)
    expect(tab(tabs, id).result?.statements).toHaveLength(1)
    expect(tab(tabs, id).running).toBe(false)
  })

  it('does not count a batch that failed, and says so', async () => {
    const { tabs, id } = await routineTab()
    runQuery.mockResolvedValue(answer({ statements: 2, error: "Invalid column name 'nope'." }))

    expect(await runQueryTab(id)).toBe(false)
    expect(tab(tabs, id).routine?.baseline).toBe(STORED)
    expect(useToastStore().toasts.map((toast) => toast.detail)).toContain(
      "Invalid column name 'nope'."
    )
  })

  it('does not count a run that was cancelled', async () => {
    const { tabs, id } = await routineTab()
    runQuery.mockResolvedValue(answer({ cancelled: true }))
    expect(await runQueryTab(id)).toBe(false)
    expect(tab(tabs, id).routine?.baseline).toBe(STORED)
  })

  it('does not count a selection, even one that ran cleanly', async () => {
    const { tabs, id } = await routineTab()
    runQuery.mockResolvedValue(answer())
    expect(await runQueryTab(id, 'SELECT 2')).toBe(false)
    expect(tab(tabs, id).routine?.baseline).toBe(STORED)
  })

  it('counts a selection that is the whole script', async () => {
    const { tabs, id } = await routineTab()
    runQuery.mockResolvedValue(answer())
    expect(await runQueryTab(id, `  ${EDITED}  `)).toBe(true)
    expect(tab(tabs, id).routine?.baseline).toBe(EDITED)
  })

  it('does not count a script with nothing in it to run', async () => {
    const { tabs, id } = await routineTab()
    runQuery.mockResolvedValue(answer({ statements: 0 }))
    expect(await runQueryTab(id)).toBe(false)
    expect(tab(tabs, id).routine?.baseline).toBe(STORED)
  })

  it('puts the tab back to idle when the call itself fails', async () => {
    const { tabs, id } = await routineTab()
    runQuery.mockRejectedValue(new Error('Connection lost - socket hang up'))
    expect(await runQueryTab(id)).toBe(false)
    expect(tab(tabs, id).running).toBe(false)
    expect(tab(tabs, id).executionId).toBeNull()
  })

  it('will not run a tab that is already running', async () => {
    const { tabs, id } = await routineTab()
    tabs.update<QueryTab>(id, { running: true })
    expect(await runQueryTab(id)).toBe(false)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('runs a tab that is not on screen', async () => {
    const { tabs, id } = await routineTab()
    await tabs.openQuery('c1', 'SELECT 1')
    expect(tabs.activeId).not.toBe(id)
    runQuery.mockResolvedValue(answer())
    expect(await runQueryTab(id)).toBe(true)
  })

  it('runs a plain query, which has no routine to save', async () => {
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    runQuery.mockResolvedValue(answer())
    expect(await runQueryTab(tabs.activeId!)).toBe(true)
    expect(tab(tabs, tabs.activeId!).routine).toBeUndefined()
  })

  it('does nothing for a tab that is gone', async () => {
    expect(await runQueryTab('tab-missing')).toBe(false)
    expect(runQuery).not.toHaveBeenCalled()
  })
})
