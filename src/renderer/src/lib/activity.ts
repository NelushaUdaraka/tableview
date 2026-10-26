/**
 * What the activity monitor makes of the server's sessions: who is blocking
 * whom, as chains with the head blocker first, and which sessions are worth
 * listing.
 */
import type { ActivitySession } from '@shared/types'

/** One line of a blocking chain: a session, and how far down the chain it is. */
export interface ChainLink {
  session: ActivitySession
  /** 0 for the head blocker, 1 for what it blocks, and so on. */
  depth: number
}

export interface BlockingChain {
  head: ActivitySession
  /** The head first, then everything waiting on it, each under what it waits on. */
  links: ChainLink[]
  /** How many sessions wait on the head, directly or not. */
  blocked: number
}

/**
 * The blocking chains among `sessions`, longest-waiting head first.
 *
 * A head blocker blocks someone and waits on nobody — or on a session that
 * is not in the list, which a login without the permission to see it gets.
 * A cycle (a deadlock the server has yet to break) has no head, so its
 * lowest-numbered session stands in for one rather than it going unseen.
 */
export function blockingChains(sessions: ActivitySession[]): BlockingChain[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  const waitingOn = new Map<number, ActivitySession[]>()
  for (const session of sessions) {
    if (session.blockedBy === null || session.blockedBy === session.sessionId) continue
    const list = waitingOn.get(session.blockedBy) ?? []
    list.push(session)
    waitingOn.set(session.blockedBy, list)
  }
  if (waitingOn.size === 0) return []

  const placed = new Set<number>()
  const chains: BlockingChain[] = []

  const build = (head: ActivitySession): void => {
    const links: ChainLink[] = []
    const visit = (session: ActivitySession, depth: number): void => {
      if (placed.has(session.sessionId)) return
      placed.add(session.sessionId)
      links.push({ session, depth })
      const waiting = [...(waitingOn.get(session.sessionId) ?? [])].sort(
        (a, b) => b.waitTimeMs - a.waitTimeMs || a.sessionId - b.sessionId
      )
      for (const next of waiting) visit(next, depth + 1)
    }
    visit(head, 0)
    chains.push({ head, links, blocked: links.length - 1 })
  }

  const heads = [...waitingOn.keys()]
    .map((id) => byId.get(id))
    .filter((session): session is ActivitySession => {
      if (!session) return false
      return session.blockedBy === null || !byId.has(session.blockedBy)
    })
  // Blockers not in the list at all — another database's, out of sight — are
  // still heads to the sessions waiting on them.
  for (const id of waitingOn.keys()) {
    if (!byId.has(id)) heads.push(placeholder(id))
  }
  for (const head of heads) build(head)

  // What is left waits in a cycle.
  for (const session of [...sessions].sort((a, b) => a.sessionId - b.sessionId)) {
    if (!placed.has(session.sessionId) && waitingOn.has(session.sessionId)) build(session)
  }

  const longestWait = (chain: BlockingChain): number =>
    Math.max(0, ...chain.links.slice(1).map((link) => link.session.waitTimeMs))
  return chains.sort((a, b) => b.blocked - a.blocked || longestWait(b) - longestWait(a))
}

/** A session known only as the one something waits on. */
function placeholder(sessionId: number): ActivitySession {
  return {
    sessionId,
    login: '',
    host: '',
    program: '',
    database: null,
    status: 'not visible',
    command: null,
    blockedBy: null,
    waitType: null,
    waitTimeMs: 0,
    waitResource: null,
    cpuMs: 0,
    logicalReads: 0,
    elapsedMs: null,
    openTransactions: 0,
    sql: null,
    sqlIsCurrent: false,
    loginTime: null,
    lastRequestEnd: null,
    ownProcess: false
  }
}

/**
 * Whether a session is doing anything worth a look: running a request, or
 * holding a transaction open while it sleeps — the one that blocks.
 */
export function isActive(session: ActivitySession): boolean {
  return session.sqlIsCurrent || session.openTransactions > 0 || session.blockedBy !== null
}

/**
 * The sessions to list: idle ones only when asked for, and those matching the
 * filter text in their login, host, program, database or statement. Busiest
 * first: blocked, then running, then by session number.
 */
export function visibleSessions(
  sessions: ActivitySession[],
  options: { showIdle: boolean; filter: string; blockers?: Set<number> }
): ActivitySession[] {
  const needle = options.filter.trim().toLowerCase()
  const blockers = options.blockers ?? new Set<number>()
  const rank = (session: ActivitySession): number =>
    blockers.has(session.sessionId) ? 0 : session.blockedBy !== null ? 1 : session.sqlIsCurrent ? 2 : 3
  return sessions
    .filter((session) => options.showIdle || isActive(session) || blockers.has(session.sessionId))
    .filter((session) => {
      if (!needle) return true
      return [
        String(session.sessionId),
        session.login,
        session.host,
        session.program,
        session.database ?? '',
        session.sql ?? ''
      ].some((field) => field.toLowerCase().includes(needle))
    })
    .sort((a, b) => rank(a) - rank(b) || a.sessionId - b.sessionId)
}

/** `850 ms`, `12.4 s`, `3 min 5 s`, `2 h 4 min`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}
