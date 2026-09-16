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

export interface QueryExecutionResult {
  executionId: string
  statements: StatementResult[]
  totalDurationMs: number
  cancelled: boolean
}

export interface RunQueryRequest {
  connectionId: string
  sql: string
  /** Execute as one batch instead of splitting into statements. */
  asSingleBatch?: boolean
  maxRows?: number
  /** Caller-supplied id so the execution can be cancelled. */
  executionId?: string
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
  connectionSortDirection: 'desc'
}

export const DEFAULT_SQLSERVER_OPTIONS: SqlServerOptions = {
  encrypt: true,
  trustServerCertificate: true,
  applicationName: 'Beekeeper Clone',
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
