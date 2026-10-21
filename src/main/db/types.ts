/**
 * The contract every database driver implements.
 *
 * The registry, the IPC layer and the renderer only ever see this interface —
 * nothing above `src/main/db/<engine>/` mentions a specific engine. Adding an
 * engine in a later phase means writing one more implementation and teaching
 * the registry which one to construct.
 */
import type {
  AppliedChanges,
  ConnectionConfig,
  DatabaseSummary,
  RoutineObject,
  SchemaObject,
  SchemaObjectType,
  ServerMessage,
  SessionLoss,
  SessionState,
  StatementResult,
  TableChangeSet,
  TableDataRequest,
  TableDataResponse,
  TableForeignKey,
  TableStructure
} from '../../shared/types'

export interface ServerInfo {
  productVersion: string
  edition: string
  productLevel: string
  machineName: string
  currentDatabase: string
  login: string
  currentUser: string
  versionString: string
}

/**
 * A change in a connection's health that nobody asked for.
 *
 * Everything else a client does happens because the renderer called it, so the
 * answer goes back as a return value. A connection dropping while the window
 * sits idle has no call to return to, so it is reported instead.
 */
export type ClientState = 'connected' | 'reconnecting' | 'disconnected'

export interface ClientStateEvent {
  state: ClientState
  /** Why the connection went, on `reconnecting` and `disconnected`. */
  error?: unknown
  /** Which attempt is in flight, so the window can say how it is going. */
  attempt?: number
}

export type ClientStateListener = (event: ClientStateEvent) => void

export interface ExecuteOptions {
  /** Stop retaining rows past this count; the total is still reported. */
  maxRows?: number
  /** Caller-supplied id so the execution can be cancelled. */
  executionId?: string
  /** Send the text as a single batch instead of splitting it. */
  asSingleBatch?: boolean
  onMessage?: (message: ServerMessage) => void
}

/** What a query tab's run came to, and where its session stands after it. */
export interface SessionRun {
  statements: StatementResult[]
  /** The session's state after the run; null when the tab has no live session. */
  session: SessionState | null
  /** Set when the tab's previous session had been lost before this run. */
  lost?: SessionLoss
}

/**
 * A tab's session changed with no run to report it: a database switch moved
 * it, or it was lost — in which case `state` is null and `lost` says what it had.
 */
export interface SessionChange {
  sessionId: string
  state: SessionState | null
  lost?: SessionState
}

export type SessionChangeListener = (change: SessionChange) => void

export interface SessionRunOptions extends ExecuteOptions {
  /** A routine's tab: the database its session opens in, and stays in. */
  pinnedDatabase?: string
}

export interface DbClient {
  readonly isConnected: boolean
  /** Local port of the SSH tunnel, when one is in use. */
  readonly tunnelPort: number | undefined
  readonly info: ServerInfo | null
  readonly currentConfig: ConnectionConfig

  connect(): Promise<ServerInfo>
  disconnect(): Promise<void>
  /** Registered by the registry so an unprompted drop reaches the window. */
  onStateChange(listener: ClientStateListener | null): void
  /**
   * Turns read-only on or off for the open connection. It holds from the next
   * statement on, with no reconnect — nothing open in the window is lost.
   */
  setReadOnly(readOnly: boolean): void

  runScript(text: string, options?: ExecuteOptions): Promise<StatementResult[]>
  /**
   * Runs a query tab's script on that tab's own session, opening it on first
   * use. What the script leaves on the session — temp tables, settings, a
   * `USE`, an open transaction — is there for the tab's next run and nowhere
   * else.
   */
  runInSession(sessionId: string, text: string, options?: SessionRunOptions): Promise<SessionRun>
  /** Ends a tab's session, rolling back anything open; the window asks first. */
  closeSession(sessionId: string): Promise<void>
  /** Registered by the registry so a session that moves or is lost reaches its window. */
  onSessionChange(listener: SessionChangeListener | null): void
  cancel(executionId: string): boolean

  listDatabases(): Promise<DatabaseSummary[]>
  listSchemas(): Promise<string[]>
  listObjects(): Promise<SchemaObject[]>
  listRoutines(): Promise<RoutineObject[]>
  useDatabase(database: string): Promise<void>

  getObjectDefinition(schema: string, name: string): Promise<string | null>
  getTableStructure(schema: string, table: string): Promise<TableStructure>
  getInboundForeignKeys(schema: string, table: string): Promise<TableForeignKey[]>
  getAutocompleteSchema(): Promise<Record<string, string[]>>

  fetchTableData(request: TableDataRequest): Promise<TableDataResponse>
  applyChanges(changeSet: TableChangeSet): Promise<AppliedChanges>

  truncateTable(schema: string, table: string): Promise<void>
  dropObject(schema: string, name: string, type: SchemaObjectType): Promise<void>
}
