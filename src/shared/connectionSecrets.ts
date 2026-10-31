/**
 * Whether a connection being tested still points where its saved secret goes.
 *
 * The "test connection" form may leave a password blank to mean "use the one
 * saved against this connection". That is only safe while the form is testing
 * the same target: a form that has changed the server or the login must not
 * borrow the saved password and send it somewhere else. A field counts as
 * changed only when the form gives it *and* it differs from what is stored, so
 * testing after editing only the database, an option or a tunnel detail still
 * reuses the secret — it is a different host or login that withholds it.
 *
 * Pure, so it is unit-tested on its own and carries no trust of the renderer.
 */
import type { ConnectionConfig, SshConfig } from './types'

function changed<T>(given: T | undefined, stored: T | undefined): boolean {
  return given !== undefined && given !== stored
}

type DbTarget = Partial<Pick<ConnectionConfig, 'host' | 'port' | 'authType' | 'username' | 'domain'>>

/** The SQL login's saved password may be reused only for the same DB target. */
export function mayReuseDbSecret(input: DbTarget, stored: DbTarget): boolean {
  return !(
    changed(input.host, stored.host) ||
    changed(input.port, stored.port) ||
    changed(input.authType, stored.authType) ||
    changed(input.username, stored.username) ||
    changed(input.domain, stored.domain)
  )
}

/** The SSH password or passphrase may be reused only for the same SSH server. */
export function mayReuseSshSecret(
  input: Partial<SshConfig> | undefined,
  stored: Partial<SshConfig> | undefined
): boolean {
  if (!stored) return false
  return !(
    changed(input?.host, stored.host) ||
    changed(input?.port, stored.port) ||
    changed(input?.username, stored.username) ||
    changed(input?.authMode, stored.authMode)
  )
}
