/**
 * Types shared between the Electron main process and the renderer.
 * Everything crossing the IPC boundary must be structured-clone safe,
 * which is why cell values use the tagged representation in `CellValue`.
 */

export type DbEngine = 'sqlserver'

export type SqlAuthType = 'sql' | 'windows' | 'azure-ad-password'

export type SshAuthMode = 'password' | 'privateKey' | 'agent'

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  username: string
  authMode: SshAuthMode
  /** Only populated in memory / when the user chose to save it. */
  password?: string
  privateKeyPath?: string
  passphrase?: string
  keepaliveIntervalMs: number
}

/** How the SSM session reaches the database. */
export type SsmMode = 'remote-host' | 'instance'

/** How a connection points at its bastion: by ID, or by the Name tag. */
export type SsmTarget = 'instance-id' | 'name'

/** Where the AWS CLI should get its credentials for this connection. */
export type SsmCredentialSource = 'cli' | 'pasted'

/** Non-secret description of a stored credential block, safe to show in the UI. */
export interface SsmCredentialSummary {
  /** Already masked, e.g. `ASIA************MPLE`. */
  accessKeyId: string
  region?: string
  temporary: boolean
  savedAt: string
  expiresAt?: string
}

export interface SsmConfig {
  enabled: boolean
  /**
   * `cli` lets the AWS CLI resolve credentials itself (profile, env, SSO…).
   * `pasted` uses the credentials pasted into the app, which is what you want
   * when you copy a block out of the AWS access portal.
   */
  credentialSource: SsmCredentialSource
  /**
   * How the bastion is found.
   *
   * `instance-id` is the ID itself, which is exact and goes stale: a redeploy
   * hands back a different one. `name` is the instance's Name tag, which
   * survives the redeploy and is resolved to whatever is answering to it at
   * the moment the connection opens. Absent means `instance-id`, so a
   * connection saved before this existed keeps working.
   */
  target?: SsmTarget
  /** The bastion, e.g. i-0123456789abcdef0 (or an mi- managed instance). */
  instanceId: string
  /**
   * The Name tag to look the bastion up by, when `target` is `name`.
   *
   * Matched by EC2, so AWS's own `*` wildcards work. Where several instances
   * answer to it, the one Systems Manager can reach is the one used.
   */
  instanceName?: string
  /**
   * `remote-host` relays through the bastion to the connection's host/port;
   * `instance` forwards to a port on the bastion itself.
   */
  mode: SsmMode
  /** AWS named profile; blank uses the default resolution chain. */
  profile?: string
  region?: string
  /** 0 or unset asks the OS for a free port, which avoids clashes. */
  localPort?: number
  /** Explicit path to the AWS CLI, when it is not on PATH. */
  awsCliPath?: string
  startTimeoutMs: number

  /**
   * The AWS credential block for this connection, encrypted at rest and
   * decrypted only inside the main process. Never sent to the renderer.
   */
  credentials?: string
  /**
   * Freshly pasted text on its way in. The main process parses it, stores the
   * encrypted result in `credentials`, and never persists this field —
   * the same contract as `ConnectionConfig.password`.
   */
  credentialsText?: string
  /** What is stored, described without secrets. */
  credentialSummary?: SsmCredentialSummary
}

export interface SqlServerOptions {
  /** TLS encryption for the TDS connection. */
  encrypt: boolean
  /** Accept self-signed / mismatched certificates. */
  trustServerCertificate: boolean
  /** Named instance, e.g. "SQLEXPRESS". When set, `port` is resolved via SQL Browser. */
  instanceName?: string
  applicationName: string
  connectTimeoutMs: number
  requestTimeoutMs: number
  /** ApplicationIntent=ReadOnly, for availability-group read replicas. */
  readOnlyIntent: boolean
  poolMin: number
  poolMax: number
  poolIdleTimeoutMs: number
  /**
   * How often to send a one-row query down an otherwise idle connection.
   *
   * An idle TDS socket is torn down by whatever sits between the app and the
   * server long before SQL Server itself minds: an AWS SSM session ends after
   * its idle timeout, and a NAT or firewall drops the mapping sooner than that.
   * The heartbeat is what keeps the path open; 0 turns it off.
   */
  keepAliveIntervalMs: number
}

export interface ConnectionConfig {
  id: string
  name: string
  /**
   * The group this connection is filed under, or nothing for the loose ones.
   *
   * Flat and named rather than a tree of folders with an identity of their
   * own: a group exists because a connection says it does, so there is no
   * empty folder to tidy up and nothing to keep in step when one is renamed
   * out of existence.
   */
  group?: string
  /** Optional accent colour shown in the UI to distinguish prod from dev. */
  color?: string
  engine: DbEngine
  host: string
  port: number
  database?: string
  authType: SqlAuthType
  username?: string
  /** Never persisted in plaintext; encrypted at rest when `savePassword` is true. */
  password?: string
  /** Windows/NTLM domain. */
  domain?: string
  savePassword: boolean
  /**
   * Refuses anything that would change the database: staged table edits,
   * truncate and drop, and any statement that is not plainly a read. Checked
   * in the main process before anything is sent, so no window can get round
   * it — but it is a safety net against the wrong window, not a permission:
   * what the login may do is still up to the server. Absent means writable.
   */
  readOnly?: boolean
  /**
   * Lets writes through, but only once each one has been shown and confirmed:
   * a script that writes, staged table edits, truncate and drop. Like
   * read-only it is enforced in the main process, which refuses a write that
   * does not say it was confirmed. Read-only wins when both are on; see
   * `shared/writeMode.ts`.
   */
  confirmWrites?: boolean
  options: SqlServerOptions
  ssh: SshConfig
  ssm: SsmConfig
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
}

/** A saved connection as it leaves the store: secrets stripped unless explicitly requested. */
export type SavedConnection = Omit<ConnectionConfig, 'password'> & {
  password?: string
  hasSavedPassword: boolean
  hasSavedSshPassword: boolean
  hasSavedSshPassphrase: boolean
  hasSavedAwsCredentials: boolean
}

// ---------------------------------------------------------------------------
// Cell values
// ---------------------------------------------------------------------------

/** Tagged wrapper for values with no faithful JSON representation. */
export type TaggedValue =
  | { t: 'date'; v: string }
  | { t: 'bytes'; v: string; n: number }
  | { t: 'bigint'; v: string }
  | { t: 'json'; v: string }

export type CellValue = string | number | boolean | null | TaggedValue

export function isTagged(value: unknown): value is TaggedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    't' in value &&
    'v' in value &&
    typeof (value as TaggedValue).t === 'string'
  )
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

export type JsKind = 'string' | 'number' | 'boolean' | 'date' | 'bytes' | 'json' | 'unknown'

export interface ColumnMeta {
  name: string
  index: number
  /** SQL type as reported by the driver, e.g. `nvarchar(50)`. */
  dataType: string
  jsKind: JsKind
  nullable: boolean
  isIdentity: boolean
  isReadOnly: boolean
}

export interface QueryResultSet {
  columns: ColumnMeta[]
  rows: CellValue[][]
  rowCount: number
  /** True when the driver stopped collecting rows because of the row cap. */
  truncated: boolean
}

/**
 * Marks a failure the user can fix in place by pasting fresh AWS credentials.
 *
 * It travels as `SerializedError.code` so the renderer can offer that instead
 * of matching on wording, which changes.
 */
export const SSM_CREDENTIALS_EXPIRED = 'SSM_CREDENTIALS_EXPIRED'

/** Marks something a read-only connection refused to send, so it can be said as such. */
export const READ_ONLY_CONNECTION = 'READ_ONLY_CONNECTION'

/**
 * Marks a write a confirm-writes connection refused because it did not come
 * confirmed — sent from somewhere that did not ask, or after the connection
 * was switched to confirming from another window.
 */
export const WRITE_NOT_CONFIRMED = 'WRITE_NOT_CONFIRMED'

/**
 * Marks a run that was not sent because the tab's session had been lost with
 * something in it the run may have counted on — an open transaction, or a
 * database of its own.
 */
export const SESSION_LOST = 'SESSION_LOST'

export interface SerializedError {
  message: string
  code?: string | number
  number?: number
  state?: number
  class?: number
  lineNumber?: number
  procName?: string
  serverName?: string
  detail?: string
}

export interface StatementResult {
  /** The SQL text of this statement/batch. */
  sql: string
  resultSets: QueryResultSet[]
  rowsAffected: number[]
  messages: ServerMessage[]
  durationMs: number
  error?: SerializedError
}

export interface ServerMessage {
  kind: 'info' | 'error'
  message: string
  number?: number
  severity?: number
  lineNumber?: number
}

/**
 * A query tab's session as last read on it, after a run or a move.
 *
 * Read rather than inferred from the script: a transaction can be opened by a
 * procedure, closed by a trigger's error, or left open by a cancel, and only
 * the server knows which happened.
 */
export interface SessionState {
  /** `@@TRANCOUNT`: 0 when no transaction is open. */
  transactionCount: number
  /** `XACT_STATE()`: 1 can commit, 0 none, -1 can only be rolled back. */
  transactionState: -1 | 0 | 1
  /** `DB_NAME()`: where the tab's next statement runs. */
  database: string
  /** When the open transaction was first seen, as an ISO time; absent with none open. */
  transactionSince?: string
}

/** A session the tab had lost, as the next run found it. */
export interface SessionLoss {
  /** What it had when it went. */
  had: SessionState
  /** Whether this run was turned down because of it. */
  refused: boolean
}

/**
 * A tab's session changed without a run: the sidebar's database switch moved
 * it, or it was lost. `state` is null once there is no session.
 */
export interface SessionEvent {
  connectionId: string
  /** The query tab's id, which is what names its session. */
  sessionId: string
  state: SessionState | null
  /** What a lost session had. */
  lost?: SessionState
}

export interface QueryExecutionResult {
  executionId: string
  statements: StatementResult[]
  totalDurationMs: number
  cancelled: boolean
  /** The tab's session after the run; absent for a run that used none. */
  session?: SessionState
  /** Set when the tab's previous session had been lost before this run. */
  sessionLost?: SessionLoss
}

export interface RunQueryRequest {
  connectionId: string
  sql: string
  /** Execute as one batch instead of splitting into statements. */
  asSingleBatch?: boolean
  maxRows?: number
  /** Caller-supplied id so the execution can be cancelled. */
  executionId?: string
  /**
   * The query tab running it: the run goes to that tab's own session, opened
   * on first use. Absent, it runs on the window's shared pool, as it always did.
   */
  sessionId?: string
  /** A routine's tab: the database its session is pinned to. */
  pinnedDatabase?: string
  /** The user was shown what this script writes and said to run it. */
  confirmedWrites?: boolean
}

// ---------------------------------------------------------------------------
// Schema metadata
// ---------------------------------------------------------------------------

export interface DatabaseSummary {
  name: string
  isSystem: boolean
  state: string
  collation?: string
  sizeMb?: number
}

export type SchemaObjectType = 'table' | 'view'

export interface SchemaObject {
  schema: string
  name: string
  type: SchemaObjectType
  rowCountEstimate?: number
}

export type RoutineType = 'procedure' | 'scalar-function' | 'table-function'

export interface RoutineObject {
  schema: string
  name: string
  type: RoutineType
}

/**
 * A routine a query tab is editing, opened from the schema tree.
 *
 * The tab's text is a `CREATE OR ALTER` script for something that already
 * exists, so it carries the definition its changes are measured against —
 * which is what lets the editor mark them, and put any one of them back.
 */
export interface RoutineSource {
  schema: string
  name: string
  /** What kind of routine it is, for the icon its tab carries. */
  type?: RoutineType
  /**
   * The database the routine lives in. A window can switch database under an
   * open tab, and the same schema-qualified name can mean a different routine
   * there.
   */
  database?: string
  /**
   * The script as the server holds it: as it was read, or as the tab last ran
   * it in full without an error — which is what writes it back.
   */
  baseline: string
}

/** Something whose definition is T-SQL text the server keeps: a routine, a view or a trigger. */
export type ModuleType = RoutineType | 'view' | 'trigger'

/** The kinds a definition search can be narrowed to; functions are one, whatever they return. */
export type ModuleKind = 'procedure' | 'function' | 'view' | 'trigger'

export const MODULE_KINDS: readonly ModuleKind[] = ['procedure', 'function', 'view', 'trigger']

/** Text to find across the definitions of the current database. */
export interface DefinitionSearchRequest {
  connectionId: string
  text: string
  matchCase?: boolean
  /** Only where the text is not part of a longer identifier. */
  wholeWord?: boolean
  /** Which kinds to search; empty or absent searches them all. */
  kinds?: ModuleKind[]
}

/** One line of a definition that matched, numbered from 1 as the editor numbers it. */
export interface DefinitionMatchLine {
  line: number
  /** The line, or the part of it around the match when it is long. */
  text: string
  /** Where in `text` each match is, as `[start, end)` offsets. */
  ranges: [number, number][]
}

export interface DefinitionMatch {
  schema: string
  name: string
  type: ModuleType
  lines: DefinitionMatchLine[]
  /** Matching lines past the ones kept in `lines`. */
  moreLines: number
}

/** A module whose definition the server will not show: encrypted, so it cannot be searched. */
export interface UnsearchableModule {
  schema: string
  name: string
  type: ModuleType
}

export interface DefinitionSearchResult {
  matches: DefinitionMatch[]
  unsearchable: UnsearchableModule[]
  /** More objects matched than were returned. */
  truncated: boolean
}

export interface TableColumn {
  name: string
  position: number
  dataType: string
  /** Fully rendered type, e.g. `decimal(18, 2)`. */
  fullType: string
  maxLength: number | null
  precision: number | null
  scale: number | null
  nullable: boolean
  defaultValue: string | null
  isIdentity: boolean
  identitySeed?: string | null
  identityIncrement?: string | null
  isComputed: boolean
  computedDefinition?: string | null
  isPrimaryKey: boolean
  collation: string | null
  description: string | null
}

export interface IndexColumn {
  name: string
  descending: boolean
  isIncluded: boolean
}

export interface TableIndex {
  name: string
  isUnique: boolean
  isPrimaryKey: boolean
  isClustered: boolean
  isDisabled: boolean
  filterDefinition: string | null
  columns: IndexColumn[]
}

export interface TableForeignKey {
  name: string
  columns: string[]
  referencedSchema: string
  referencedTable: string
  referencedColumns: string[]
  onDelete: string
  onUpdate: string
  isDisabled: boolean
}

export interface TableTrigger {
  name: string
  isDisabled: boolean
  isInsteadOf: boolean
  events: string[]
}

export interface TableConstraint {
  name: string
  type: 'check' | 'unique' | 'default'
  definition: string
  column: string | null
}

export interface TableStructure {
  schema: string
  name: string
  type: SchemaObjectType
  columns: TableColumn[]
  primaryKey: string[]
  indexes: TableIndex[]
  foreignKeys: TableForeignKey[]
  triggers: TableTrigger[]
  constraints: TableConstraint[]
  rowCountEstimate: number | null
}

// ---------------------------------------------------------------------------
// Table data browsing / editing
// ---------------------------------------------------------------------------

export type FilterOperator =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'like'
  | 'not like'
  | 'starts with'
  | 'ends with'
  | 'contains'
  | 'in'
  | 'not in'
  | 'between'
  | 'is null'
  | 'is not null'

export interface TableFilter {
  column: string
  operator: FilterOperator
  value?: string
  value2?: string
  /** Joins this filter to the previous one. Ignored on the first filter. */
  conjunction?: 'AND' | 'OR'
}

export interface TableSort {
  column: string
  direction: 'asc' | 'desc'
}

export interface TableDataRequest {
  connectionId: string
  schema: string
  table: string
  offset: number
  limit: number
  sorts: TableSort[]
  filters: TableFilter[]
  filterMode: 'builder' | 'raw'
  rawWhere?: string
}

export interface TableDataResponse {
  columns: ColumnMeta[]
  rows: CellValue[][]
  offset: number
  limit: number
  /** Total matching rows; null when counting was skipped. */
  totalRows: number | null
  durationMs: number
  sql: string
}

export interface PendingInsert {
  tempId: string
  values: Record<string, CellValue>
}

export interface PendingUpdate {
  /** Values identifying the row (primary key, or every column when there is none). */
  key: Record<string, CellValue>
  changes: Record<string, CellValue>
}

export interface PendingDelete {
  key: Record<string, CellValue>
}

export interface TableChangeSet {
  connectionId: string
  schema: string
  table: string
  inserts: PendingInsert[]
  updates: PendingUpdate[]
  deletes: PendingDelete[]
  /** The user was shown these edits and said to apply them; see `confirmWrites`. */
  confirmed?: boolean
}

export interface AppliedChanges {
  inserted: number
  updated: number
  deleted: number
  statements: string[]
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ConnectionStatus {
  connectionId: string
  state: ConnectionState
  error?: SerializedError
  serverVersion?: string
  serverEdition?: string
  currentDatabase?: string
  currentUser?: string
  /** Local port the SSH tunnel is listening on, when tunnelling. */
  tunnelPort?: number
  /**
   * Whether the open connection refuses writes, as it was opened — which is
   * what the main process enforces, even if the saved setting has changed
   * since. Only an open connection says; a status about one coming or going
   * leaves it out.
   */
  readOnly?: boolean
  /** Whether the open connection asks before each write, said the same way. */
  confirmWrites?: boolean
}

// ---------------------------------------------------------------------------
// History & saved queries
// ---------------------------------------------------------------------------

export interface QueryHistoryEntry {
  id: string
  connectionId: string
  connectionName: string
  database?: string
  sql: string
  runAt: string
  durationMs: number
  rowCount: number
  success: boolean
  errorMessage?: string
}

export interface SavedQuery {
  id: string
  name: string
  sql: string
  connectionId?: string
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'jsonl' | 'sql' | 'markdown'

export interface ExportOptions {
  format: ExportFormat
  /** Only for the `sql` format. */
  tableName?: string
  includeHeader: boolean
  delimiter?: string
  nullString?: string
  lineEnding?: '\n' | '\r\n'
}

export interface ExportRequest extends ExportOptions {
  columns: ColumnMeta[]
  rows: CellValue[][]
  filePath?: string
}

// ---------------------------------------------------------------------------
// App preferences
// ---------------------------------------------------------------------------

/**
 * What the connection screen orders the saved list by.
 *
 * A saved connection is found by the thing the reader remembers about it: the
 * name they gave it, the last time they opened it, or simply that they made it
 * this morning — which is why `created` is where the list starts.
 */
export type ConnectionSortKey = 'created' | 'name' | 'lastUsed' | 'host'

export type ConnectionSortDirection = 'asc' | 'desc'

export interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  fontSize: number
  editorFontFamily: string
  pageSize: number
  maxResultRows: number
  autoCommitEdits: boolean
  confirmBeforeApply: boolean
  /** Show the selected row's fields beside the table grid. */
  showRowPanel: boolean
  /** Width of that panel, in pixels. */
  rowPanelWidth: number
  formatterKeywordCase: 'upper' | 'lower' | 'preserve'
  formatterIndent: number
  /** How the connection screen sorts the saved list, and which way round. */
  connectionSort: ConnectionSortKey
  connectionSortDirection: ConnectionSortDirection
  /**
   * Look for a new release on its own, and fetch it. Off leaves updating to
   * whoever asks for it: nothing is checked, downloaded or installed unasked.
   */
  autoUpdate: boolean
  /**
   * Reopen the tabs a connection had open when it is next connected to,
   * restarts included. Off forgets the ones already kept.
   */
  restoreTabs: boolean
  /**
   * Say on the desktop when a query that ran a while finishes while its
   * window is in the background, and after how many seconds a run counts.
   */
  notifyLongQueries: boolean
  notifyAfterSeconds: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  fontSize: 13,
  editorFontFamily: "'JetBrains Mono', 'Cascadia Mono', 'Consolas', 'Menlo', monospace",
  pageSize: 200,
  maxResultRows: 50000,
  autoCommitEdits: false,
  confirmBeforeApply: true,
  showRowPanel: true,
  rowPanelWidth: 340,
  formatterKeywordCase: 'upper',
  formatterIndent: 2,
  connectionSort: 'created',
  connectionSortDirection: 'desc',
  autoUpdate: true,
  restoreTabs: true,
  notifyLongQueries: true,
  notifyAfterSeconds: 10
}

export const DEFAULT_SQLSERVER_OPTIONS: SqlServerOptions = {
  encrypt: true,
  trustServerCertificate: true,
  applicationName: 'TableView',
  connectTimeoutMs: 15000,
  requestTimeoutMs: 60000,
  readOnlyIntent: false,
  poolMin: 0,
  poolMax: 5,
  poolIdleTimeoutMs: 30000,
  keepAliveIntervalMs: 60000
}

export const DEFAULT_SSM_CONFIG: SsmConfig = {
  enabled: false,
  credentialSource: 'pasted',
  target: 'instance-id',
  instanceId: '',
  instanceName: '',
  mode: 'remote-host',
  startTimeoutMs: 30000
}

export const DEFAULT_SSH_CONFIG: SshConfig = {
  enabled: false,
  host: '',
  port: 22,
  username: '',
  authMode: 'password',
  keepaliveIntervalMs: 10000
}
