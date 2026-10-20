/**
 * Connecting where the connection was last left: in the database switched to
 * from the sidebar, rather than back in the one its settings name.
 *
 * The connection opens as its settings say and then switches, before anyone
 * is told it is open, so the workspace never reads the other database's
 * schema first. It does not open straight into the remembered database: a
 * login to a database the server will not open fails with "Login failed for
 * user", the same words a wrong password gets (the driver keeps only the
 * last of the server's errors), so a retry could not tell the two apart and
 * would spend a second failed login on every wrong password. Switching after
 * the login has worked has no such doubt — and a database that can no longer
 * be opened leaves the connection open where its settings say, and is
 * forgotten.
 */
import type { ConnectionStatus } from '../../shared/types'

export interface RememberedSwitch {
  status: ConnectionStatus
  /** The remembered database could not be opened, and should be forgotten. */
  forget: boolean
}

export async function enterRememberedDatabase(
  status: ConnectionStatus,
  remembered: string | undefined,
  useDatabase: (database: string) => Promise<ConnectionStatus>
): Promise<RememberedSwitch> {
  if (status.state !== 'connected' || !remembered || remembered === status.currentDatabase) {
    return { status, forget: false }
  }
  try {
    return { status: await useDatabase(remembered), forget: false }
  } catch {
    return { status, forget: true }
  }
}
