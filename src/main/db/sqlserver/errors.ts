/**
 * Driver errors that mean the socket went away rather than the server refusing
 * something. Only these may be reinterpreted as a tunnel failure — a login
 * rejection travels the same path and must reach the user unchanged — and only
 * these end a tab's session: a statement the server refused, or did not run,
 * leaves the connection as it was.
 */
export function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /socket hang up|connection lost|econnreset|epipe|read econnreset/i.test(message)
}

/** What Node calls a certificate it would not accept. */
const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID'
])

/**
 * The words to show for a connection turned down over the server's
 * certificate, or null when that is not what happened.
 *
 * The driver's own message ends at Node's reason — "self-signed certificate" —
 * which says what went wrong but not what to do. Most servers on a private
 * network have exactly such a certificate, so the way past it is named.
 */
export function untrustedCertificate(error: unknown): string | null {
  // mssql wraps tedious, which wraps the TLS error that has the code.
  let refused = false
  const seen = new Set<unknown>()
  let current: unknown = error
  while (!refused && current instanceof Error && !seen.has(current)) {
    seen.add(current)
    const coded = current as Error & { code?: string; originalError?: unknown }
    refused = Boolean(coded.code && CERTIFICATE_CODES.has(coded.code))
    current = coded.originalError ?? coded.cause
  }
  if (!refused || !(error instanceof Error)) return null
  return (
    `${error.message}. The server's certificate is not one this computer trusts, so the ` +
    'connection was not made: anyone between here and the server could have offered it. If ' +
    'this is the server you meant and it uses a certificate of its own making, tick "Trust ' +
    'server certificate" under Advanced in the connection\'s settings.'
  )
}
