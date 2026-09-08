/**
 * Expiry can surface from a connect, a test, or a query hours later, and every
 * one of those places asks the same question of this store.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SSM_CREDENTIALS_EXPIRED, type SavedConnection } from '../../../src/shared/types'
import {
  isExpiredCredentialsError,
  useCredentialsStore
} from '../../../src/renderer/src/stores/credentials'

beforeEach(() => setActivePinia(createPinia()))

const connection = { id: 'c1', name: 'LnF Dev' } as SavedConnection

describe('recognising an expiry', () => {
  it('goes by the code, not the wording', () => {
    expect(isExpiredCredentialsError({ message: 'anything', code: SSM_CREDENTIALS_EXPIRED })).toBe(
      true
    )
    // The same words without the code are some other failure's business.
    expect(isExpiredCredentialsError({ message: 'credentials have expired' })).toBe(false)
    expect(isExpiredCredentialsError({ message: 'Login failed for user' })).toBe(false)
    expect(isExpiredCredentialsError(null)).toBe(false)
    expect(isExpiredCredentialsError(undefined)).toBe(false)
  })
})

describe('offering the fix', () => {
  it('raises the prompt and says it did, so the caller drops its toast', () => {
    const store = useCredentialsStore()
    const retry = vi.fn()

    const offered = store.offerRefresh(
      connection,
      { message: 'expired at 09:00 UTC', code: SSM_CREDENTIALS_EXPIRED },
      retry
    )

    expect(offered).toBe(true)
    expect(store.prompt?.connection.id).toBe('c1')
    expect(store.prompt?.message).toBe('expired at 09:00 UTC')
    // The retry runs when the dialog is done with it, not before.
    expect(retry).not.toHaveBeenCalled()
  })

  it('stays out of the way of every other failure', () => {
    const store = useCredentialsStore()
    expect(store.offerRefresh(connection, { message: 'Login failed for user' })).toBe(false)
    expect(store.prompt).toBeNull()
  })

  it('needs a saved connection to save the credentials against', () => {
    const store = useCredentialsStore()
    const error = { message: 'expired', code: SSM_CREDENTIALS_EXPIRED }
    expect(store.offerRefresh(null, error)).toBe(false)
    expect(store.prompt).toBeNull()
  })

  it('clears on dismiss', () => {
    const store = useCredentialsStore()
    store.offerRefresh(connection, { message: 'expired', code: SSM_CREDENTIALS_EXPIRED })
    store.dismiss()
    expect(store.prompt).toBeNull()
  })
})
