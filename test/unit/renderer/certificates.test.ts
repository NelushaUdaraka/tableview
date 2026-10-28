/**
 * A server whose certificate this computer cannot check — one it made for
 * itself, as most private servers have — is turned down, and the window offers
 * to trust it and try again rather than leaving the user to find the checkbox.
 */
import { describe, expect, it } from 'vitest'
import {
  CERTIFICATE_NOT_TRUSTED,
  DEFAULT_SQLSERVER_OPTIONS,
  SSM_CREDENTIALS_EXPIRED,
  type SavedConnection
} from '../../../src/shared/types'
import {
  isUntrustedCertificateError,
  trustCertificateQuestion,
  withTrustedCertificate
} from '../../../src/renderer/src/lib/certificates'

describe('isUntrustedCertificateError', () => {
  it('goes by the code, not the wording', () => {
    expect(isUntrustedCertificateError({ message: 'x', code: CERTIFICATE_NOT_TRUSTED })).toBe(true)
    expect(isUntrustedCertificateError({ message: 'self-signed certificate' })).toBe(false)
    expect(isUntrustedCertificateError({ message: 'x', code: SSM_CREDENTIALS_EXPIRED })).toBe(false)
    expect(isUntrustedCertificateError(null)).toBe(false)
    expect(isUntrustedCertificateError(undefined)).toBe(false)
  })
})

describe('withTrustedCertificate', () => {
  it('turns trust on and leaves every other setting as it was', () => {
    const input = {
      name: 'Dev',
      host: 'sql.dev.internal',
      options: { ...DEFAULT_SQLSERVER_OPTIONS, encrypt: true, requestTimeoutMs: 1234 }
    }
    const trusted = withTrustedCertificate(input)
    expect(trusted.options).toEqual({ ...input.options, trustServerCertificate: true })
    expect(trusted.host).toBe('sql.dev.internal')
    // The caller's copy is not changed underneath it.
    expect(input.options.trustServerCertificate).toBe(false)
  })

  it('fills in the defaults when there are no options to start from', () => {
    expect(withTrustedCertificate({ name: 'Dev' }).options).toEqual({
      ...DEFAULT_SQLSERVER_OPTIONS,
      trustServerCertificate: true
    })
  })
})

describe('trustCertificateQuestion', () => {
  const connection = { name: 'Dev', host: 'sql.dev.internal', port: 1433 } as SavedConnection

  it('names the server, says what trusting gives up, and offers to retry', () => {
    const question = trustCertificateQuestion(connection, 'saved')
    expect(question.title).toBe('Trust the certificate of sql.dev.internal:1433?')
    expect(question.action).toBe('Trust and retry')
    expect(question.message).toMatch(/still encrypted/)
    expect(question.message).toMatch(/saved with “Dev”/)
  })

  it('says it only ticks the box when the form has not been saved', () => {
    expect(trustCertificateQuestion(connection, 'form').message).toMatch(/Save/)
  })
})
