/**
 * One query tab's session: a single connection to SQL Server, held for as
 * long as the tab is open.
 *
 * What a script sets up on its session — a temp table, a `SET` option, a `USE`,
 * an open transaction — is still there for the tab's next run, and reaches
 * nothing else in the window: the schema tree, the table tabs and completion
 * keep to the client's shared pool.
 *
 * The connection is never replaced behind the tab's back. When it ends —
 * killed by the server, its socket gone — the session is lost for good and
 * says so, with what it had; a new one is the client's decision, made when the
 * tab next runs and knowing what was lost.
 */
import sql from 'mssql'
import type { ConnectionConfig, SessionState } from '../../../shared/types'
import { ROLLBACK_SQL, STATE_SQL, withTransactionSince } from '../../../shared/sessions'
import { quoteIdent } from '../../../shared/sql/identifiers'
import { buildSessionConfig, type TunnelEndpoint } from './config'

/** Told once, when the session's connection ends without the tab ending it. */
export type SessionLostListener = (had: SessionState) => void

/** The parts of a tedious connection the session watches. */
interface DriverConnection {
  on(event: 'end' | 'error', listener: () => void): unknown
  close(): void
}

/**
 * How long closing waits for its `ROLLBACK`. A connection that died without a
 * word would otherwise hold the close for the whole request timeout; closing
 * the connection rolls the transaction back on the server anyway.
 */
const ROLLBACK_ON_CLOSE_MS = 2000

const CLOSED = "This tab's session was closed."

export class QuerySession {
  /** As last read on the session, after a run or a move. */
  state: SessionState | null = null
  /** What it had when its connection ended; from then on it is never used again. */
  lost: SessionState | null = null
  /** A run, a state read or a `USE` is in flight. */
  busy = false
  /**
   * The sidebar switched database while a run was going: once it ends, the
   * session follows from `from` to `to` — if it is still where the sidebar was.
   */
  pendingFollow: { from: string; to: string } | null = null
  /** When a heartbeat last went down the session's connection, as `Date.now()`. */
  lastHeartbeatAt: number | null = null

  private current: sql.ConnectionPool | null = null
  /** The connection the session is, once it has one. */
  private connection: DriverConnection | null = null
  /** mssql's trial connection is behind it: every connection from now on is the session's. */
  private settled = false
  /** Ending it on purpose, so its connection's end is not a loss. */
  private closing = false

  private constructor(
    readonly pinnedDatabase: string | undefined,
    private readonly database: string,
    private readonly onLost: SessionLostListener
  ) {}

  /** Opens a session in `database`, connected and with its state read. */
  static async open(
    connection: ConnectionConfig,
    tunnel: TunnelEndpoint | null,
    database: string,
    options: { pinnedDatabase?: string; onLost: SessionLostListener }
  ): Promise<QuerySession> {
    const session = new QuerySession(options.pinnedDatabase, database, options.onLost)
    const pool = new sql.ConnectionPool(
      buildSessionConfig(connection, tunnel, database, (driver) =>
        session.adopt(driver as DriverConnection)
      )
    )
    // Without a listener an idle-pool error would crash the main process.
    pool.on('error', (error) => {
      // eslint-disable-next-line no-console
      console.error('[mssql] session pool error:', error?.message ?? error)
    })

    try {
      await pool.connect()
    } catch (error) {
      await pool.close().catch(() => undefined)
      throw error
    }
    session.current = pool
    session.settled = true

    try {
      // Makes the connection the session is, and tells the tab where it is.
      await session.readState()
    } catch (error) {
      await session.close()
      throw error
    }
    return session
  }

  /** The session's pool; once it is lost or closed there is none. */
  get pool(): sql.ConnectionPool {
    if (!this.current || this.lost) throw new Error(CLOSED)
    return this.current
  }

  /**
   * Sees every connection the pool makes.
   *
   * The first after mssql's own trial is the session; one after that is the
   * pool swapping a dead session for a fresh one, which is exactly what must
   * not happen: it is closed before it can carry anything, which fails the
   * request that wanted it, and the session is lost.
   */
  private adopt(driver: DriverConnection): void {
    if (!this.settled) return
    if (this.connection) {
      this.markLost()
      driver.close()
      return
    }
    this.connection = driver
    const ended = (): void => {
      if (!this.closing) this.markLost()
    }
    driver.on('end', ended)
    driver.on('error', ended)
  }

  /** Reads `@@TRANCOUNT`, `XACT_STATE()` and `DB_NAME()` on the session. */
  async readState(now = new Date()): Promise<SessionState> {
    let row: Record<string, unknown>
    try {
      const result = await this.pool.request().query(STATE_SQL)
      row = result.recordset[0] as Record<string, unknown>
    } catch (error) {
      // A session that cannot say where it is cannot be run on either.
      this.markLost()
      throw error
    }
    const xact = Number(row.transactionState)
    this.state = withTransactionSince(
      this.state,
      {
        transactionCount: Number(row.transactionCount),
        transactionState: xact === 1 ? 1 : xact === -1 ? -1 : 0,
        database: String(row.database)
      },
      now
    )
    return this.state
  }

  /** Moves the session to `database`, as the app's own `USE`, and reads where it is. */
  async use(database: string): Promise<SessionState> {
    await this.pool.request().batch(`USE ${quoteIdent(database)}`)
    return this.readState()
  }

  /**
   * Sends one row down an idle session, so a tunnel or a firewall does not
   * cut it off for want of traffic. A session that cannot answer is lost.
   */
  async heartbeat(): Promise<void> {
    if (this.busy || this.lost || this.closing || !this.current) return
    try {
      await this.current.request().query('SELECT 1')
      this.lastHeartbeatAt = Date.now()
    } catch {
      this.markLost()
    }
  }

  /**
   * Lets go of a session whose connection has gone with the rest of the
   * transport: there is nothing to send a `ROLLBACK` down, and the loss has
   * been reported already.
   */
  async abandon(): Promise<void> {
    this.closing = true
    const pool = this.current
    this.current = null
    await pool?.close().catch(() => undefined)
  }

  /** The connection ended without the tab ending it. Said once. */
  markLost(): void {
    if (this.lost || this.closing) return
    this.lost = this.state ?? { transactionCount: 0, transactionState: 0, database: this.database }
    const pool = this.current
    this.current = null
    void pool?.close().catch(() => undefined)
    this.onLost(this.lost)
  }

  /**
   * Ends the session on purpose: rolls back whatever is still open, then
   * closes the connection. Whoever calls this has asked about the transaction
   * first; nothing here is reported as a loss.
   */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const pool = this.current
    this.current = null
    if (!pool) return
    if (!this.lost) {
      await Promise.race([
        pool.request().batch(ROLLBACK_SQL).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, ROLLBACK_ON_CLOSE_MS).unref?.())
      ])
    }
    await pool.close().catch(() => undefined)
  }
}
