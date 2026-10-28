/**
 * A server whose certificate this computer cannot check.
 *
 * New connections check the server's certificate, and most servers on a
 * private network have one they made for themselves, which nothing can check.
 * Rather than leave the user to find *Trust server certificate* under
 * Advanced, the window offers it where the connection failed: say what
 * trusting gives up, and try again with it on.
 */
import {
  CERTIFICATE_NOT_TRUSTED,
  DEFAULT_SQLSERVER_OPTIONS,
  type ConnectionConfig,
  type SavedConnection,
  type SerializedError,
  type SqlServerOptions
} from '@shared/types'
import type { Question } from '../stores/confirm'

/** Whether this failure is a certificate trusting would get past. */
export function isUntrustedCertificateError(error: unknown): boolean {
  if (!error) return false
  return (error as SerializedError | { code?: unknown }).code === CERTIFICATE_NOT_TRUSTED
}

/** The same connection with *Trust server certificate* on, and nothing else changed. */
export function withTrustedCertificate<T extends Partial<ConnectionConfig>>(
  input: T
): T & { options: SqlServerOptions } {
  return {
    ...input,
    options: { ...DEFAULT_SQLSERVER_OPTIONS, ...input.options, trustServerCertificate: true }
  }
}

/**
 * The question to ask before trusting it. `saved` is a connection opened from
 * the list, which keeps the setting; `form` is one being tested in the form,
 * which keeps it only once saved.
 */
export function trustCertificateQuestion(
  connection: Pick<SavedConnection, 'name' | 'host' | 'port'>,
  where: 'saved' | 'form'
): Question {
  const kept =
    where === 'saved'
      ? `This is saved with “${connection.name}”, as Trust server certificate under Advanced.`
      : 'This ticks Trust server certificate in the form; it is kept when you Save.'
  return {
    kicker: 'Certificate',
    title: `Trust the certificate of ${connection.host}:${connection.port}?`,
    message:
      'This computer cannot check the server’s certificate — most often because the server made ' +
      'it for itself. Trusting it connects anyway, still encrypted, but with no proof that the ' +
      'server is the one you meant. Only trust a server you know. ' +
      kept,
    action: 'Trust and retry'
  }
}
