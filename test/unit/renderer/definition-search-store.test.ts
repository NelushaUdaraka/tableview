/**
 * The Search panel's list: a text search and a reference lookup share it, and
 * only the latest question's answer is ever shown.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DefinitionSearchResult } from '../../../src/shared/types'

const searchDefinitions = vi.fn()
const findReferences = vi.fn()

vi.mock('../../../src/renderer/src/lib/api', () => ({
  api: {
    searchDefinitions: (...args: unknown[]) => searchDefinitions(...args),
    findReferences: (...args: unknown[]) => findReferences(...args)
  }
}))

const { useDefinitionSearchStore } = await import(
  '../../../src/renderer/src/stores/definitionSearch'
)

function found(name: string): DefinitionSearchResult {
  return {
    matches: [
      {
        schema: 'dbo',
        name,
        type: 'procedure',
        lines: [{ line: 3, text: 'x', ranges: [[0, 1]] }],
        moreLines: 2
      }
    ],
    unsearchable: [],
    truncated: false
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  searchDefinitions.mockReset()
  findReferences.mockReset()
})

describe('definition search store', () => {
  it('sends the text, trimmed, with the options set', async () => {
    searchDefinitions.mockResolvedValue(found('usp_a'))
    const store = useDefinitionSearchStore()
    store.text = '  orders '
    store.wholeWord = true
    store.toggleKind('view')
    await store.search('c1', 'Sales')

    expect(searchDefinitions).toHaveBeenCalledWith({
      connectionId: 'c1',
      text: 'orders',
      matchCase: false,
      wholeWord: true,
      kinds: ['procedure', 'function', 'trigger']
    })
    expect(store.question).toEqual({
      mode: 'text',
      text: 'orders',
      matchCase: false,
      wholeWord: true,
      database: 'Sales'
    })
    expect(store.result?.matches[0].name).toBe('usp_a')
    expect(store.lineCount).toBe(3)
    expect(store.loading).toBe(false)
  })

  it('puts a kind back where it was in the list', () => {
    const store = useDefinitionSearchStore()
    store.toggleKind('procedure')
    store.toggleKind('procedure')
    expect(store.kinds).toEqual(['procedure', 'function', 'view', 'trigger'])
  })

  it('clears instead of searching for nothing', async () => {
    const store = useDefinitionSearchStore()
    store.text = '   '
    await store.search('c1', 'Sales')
    expect(searchDefinitions).not.toHaveBeenCalled()
    expect(store.question).toBeNull()
  })

  it('shows only the latest answer when an older one arrives late', async () => {
    const slow = deferred<DefinitionSearchResult>()
    searchDefinitions.mockReturnValueOnce(slow.promise)
    findReferences.mockResolvedValue(found('v_orders'))
    const store = useDefinitionSearchStore()
    store.text = 'orders'

    const first = store.search('c1', 'Sales')
    await store.findReferences('c1', 'Sales', 'dbo', 'orders')
    slow.resolve(found('usp_stale'))
    await first

    expect(store.question).toMatchObject({ mode: 'references', name: 'orders' })
    expect(store.result?.matches[0].name).toBe('v_orders')
  })

  it('keeps a failure as a message on the list', async () => {
    findReferences.mockRejectedValue(new Error('no permission'))
    const store = useDefinitionSearchStore()
    await store.findReferences('c1', 'Sales', 'dbo', 'orders')
    expect(store.error).toBe('no permission')
    expect(store.result).toBeNull()
    expect(store.loading).toBe(false)
  })
})
