/**
 * The yes-or-no question asked over the window in place of `confirm()`.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useConfirmStore } from '../../../src/renderer/src/stores/confirm'

beforeEach(() => {
  setActivePinia(createPinia())
})

const question = { kicker: 'Table', title: 'Drop dbo.t?', message: 'Gone.', action: 'Drop' }

describe('confirm store', () => {
  it('resolves with the answer and takes the question down', async () => {
    const store = useConfirmStore()
    const asked = store.ask(question)
    expect(store.question?.title).toBe('Drop dbo.t?')
    store.answer(true)
    expect(store.question).toBeNull()
    await expect(asked).resolves.toBe(true)
  })

  it('withdraws a question still on screen when another is asked', async () => {
    const store = useConfirmStore()
    const first = store.ask(question)
    const second = store.ask({ ...question, title: 'Truncate dbo.t?' })
    await expect(first).resolves.toBe(false)
    expect(store.question?.title).toBe('Truncate dbo.t?')
    store.answer(false)
    await expect(second).resolves.toBe(false)
  })
})
