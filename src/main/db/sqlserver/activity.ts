/**
 * The activity monitor's rows, from what the DMVs return.
 *
 * Kept apart from the client so the shaping — which sessions are this app's
 * own, which permission is missing — can be tested without a server.
 */
import type { ActivitySession, ServerActivity } from '../../../shared/types'
import { STATE_SQL } from '../../../shared/sessions'

/** Azure SQL Database: its DMVs answer to a database permission, not a server one. */
const AZURE_SQL_DATABASE = 5

export interface ActivityMeta {
  monitorSessionId: unknown
  engineEdition: unknown
  serverState: unknown
  databaseState: unknown
}

/** The process this app's connections log in from, as tedious tells the server. */
export interface OwnProcess {
  pid: number
  host: string
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function count(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function when(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  return text(value)
}

/** The permission that is missing for this login to see every session, if one is. */
export function missingActivityPermission(meta: ActivityMeta): string | undefined {
  if (Number(meta.engineEdition) === AZURE_SQL_DATABASE) {
    return Number(meta.databaseState) === 1 ? undefined : 'VIEW DATABASE STATE'
  }
  return Number(meta.serverState) === 1 ? undefined : 'VIEW SERVER STATE'
}

/** This window's query tabs among the sessions, and the last batch each sent. */
export interface TabSessions {
  /** Server session id to tab id. */
  tabs: Record<number, string>
  lastBatches: Record<number, string>
}

/**
 * What an idle session last sent, as far as anyone would care. A query tab's
 * session ends every run with the app's own state read, which is what the
 * server remembers; the tab's own last batch is what it was doing.
 */
function lastStatement(row: Record<string, unknown>, known: TabSessions): string | null {
  const sql = text(row.sql)?.trim() || null
  if (sql !== STATE_SQL.trim()) return sql
  return known.lastBatches[count(row.sessionId)]?.trim() || null
}

export function serverActivity(
  meta: ActivityMeta,
  rows: Record<string, unknown>[],
  own: OwnProcess,
  known: TabSessions = { tabs: {}, lastBatches: {} },
  readAt = new Date()
): ServerActivity {
  const sessions = rows.map(
    (row): ActivitySession => ({
      sessionId: count(row.sessionId),
      login: text(row.login) ?? '',
      host: text(row.host)?.trim() ?? '',
      program: text(row.program)?.trim() ?? '',
      database: text(row.database),
      status: text(row.status)?.trim() ?? '',
      command: text(row.command)?.trim() || null,
      blockedBy: row.blockedBy === null || row.blockedBy === undefined ? null : count(row.blockedBy),
      waitType: text(row.waitType),
      waitTimeMs: count(row.waitTimeMs),
      waitResource: text(row.waitResource)?.trim() || null,
      cpuMs: count(row.cpuMs),
      logicalReads: count(row.logicalReads),
      elapsedMs: row.elapsedMs === null || row.elapsedMs === undefined ? null : count(row.elapsedMs),
      openTransactions: count(row.openTransactions),
      sql: lastStatement(row, known),
      sqlIsCurrent: Boolean(row.sqlIsCurrent),
      loginTime: when(row.loginTime),
      lastRequestEnd: when(row.lastRequestEnd),
      // The client's process id and host name go to the server at login; a
      // session from this process, whichever window opened it, is ours.
      ownProcess:
        count(row.hostProcessId) === own.pid &&
        (text(row.host)?.trim() ?? '').toLowerCase() === own.host.toLowerCase()
    })
  )
  const missing = missingActivityPermission(meta)
  return {
    sessions,
    monitorSessionId: count(meta.monitorSessionId),
    tabSessions: known.tabs,
    ...(missing ? { missingPermission: missing } : {}),
    readAt: readAt.toISOString()
  }
}

/** A session number `KILL` will take: a whole number in a session id's range. */
export function validSessionId(value: unknown): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id < 1 || id > 32767) {
    throw new Error(`${String(value)} is not a session id.`)
  }
  return id
}
