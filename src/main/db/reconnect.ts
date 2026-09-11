/**
 * When to try a dropped connection again, and when to stop.
 *
 * Kept apart from the client so the policy can be read — and tested — without
 * a server to drop a connection from.
 */
import { SSM_CREDENTIALS_EXPIRED } from '../../shared/types'

/**
 * Waits between attempts, in order.
 *
 * The first is almost immediate because most drops are a socket that went away
 * while the far end is perfectly healthy — a tunnel that idled out, a NAT that
 * forgot the mapping — and reopening it works first time. The later ones back
 * off for the case that is really down, and the last is repeated.
 */
export const RECONNECT_DELAYS_MS = [500, 2000, 5000, 15000, 30000]

/**
 * How many attempts before the connection is called gone.
 *
 * Long enough to ride out a sleeping laptop or a bastion being replaced —
 * roughly eight minutes with the delays above — and short of trying forever,
 * which for an SSM connection means spawning a CLI session every half minute
 * for as long as the window is open.
 */
export const MAX_RECONNECT_ATTEMPTS = 20

/**
 * Whether reopening the connection could possibly work.
 *
 * Credentials that ran out and a login the server refuses are not going to fix
 * themselves, and retrying them for eight minutes only delays telling the user
 * the one thing they need to know.
 */
export function isHopeless(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === SSM_CREDENTIALS_EXPIRED || code === 'ELOGIN'
}

export interface RetryDecision {
  retry: boolean
  /** Meaningless when `retry` is false. */
  delayMs: number
}

/** `attempt` counts the attempts made so far, including the one that failed. */
export function planReconnect(attempt: number, error: unknown): RetryDecision {
  if (isHopeless(error) || attempt >= MAX_RECONNECT_ATTEMPTS) {
    return { retry: false, delayMs: 0 }
  }
  const index = Math.min(Math.max(attempt - 1, 0), RECONNECT_DELAYS_MS.length - 1)
  return { retry: true, delayMs: RECONNECT_DELAYS_MS[index] }
}
