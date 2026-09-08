/**
 * Host-address predicates shared by the main process and the connection form.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]'])

/**
 * Whether an address means "this machine" to whoever resolves it.
 *
 * It matters for a tunnel because the resolver is the far end, not the app:
 * a loopback address sent through a relay names the relay itself, which is
 * almost never the database and reads as a working setting until it fails.
 */
export function isLoopbackHost(host: string | undefined | null): boolean {
  const trimmed = host?.trim().toLowerCase()
  if (!trimmed) return false
  // A trailing dot is a fully-qualified "localhost.", still loopback.
  return LOOPBACK.has(trimmed.replace(/\.$/, ''))
}
