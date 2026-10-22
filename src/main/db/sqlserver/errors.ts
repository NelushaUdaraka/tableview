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
