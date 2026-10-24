/**
 * How freely a connection lets the window write.
 *
 * Two settings are saved with a connection, each with a switch of its own:
 * read-only, and confirm writes. Read-only wins, so a connection is in one of
 * three modes. Kept as two settings rather than one three-way choice so that
 * read-only goes back where it came from: a connection that confirmed its
 * writes before it was made read-only confirms them again when read-only comes
 * off, rather than coming back unguarded.
 */
export type WriteMode = 'read-only' | 'confirm' | 'write'

/** The two settings behind a mode, as a connection or its open client holds them. */
export interface WriteGuard {
  readOnly: boolean
  confirmWrites: boolean
}

export function writeModeOf(guard: { readOnly?: boolean; confirmWrites?: boolean }): WriteMode {
  if (guard.readOnly === true) return 'read-only'
  return guard.confirmWrites === true ? 'confirm' : 'write'
}

/**
 * Whether going from one mode to the other asks first.
 *
 * Only a move to writing freely does. Read-only to confirm writes still asks
 * before every write, so asking about the switch as well would only teach the
 * user to click through.
 */
export function switchAsks(from: WriteMode, to: WriteMode): boolean {
  return to === 'write' && from !== 'write'
}
