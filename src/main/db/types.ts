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

export interface ExecuteOptions {
  /** Stop retaining rows past this count; the total is still reported. */
  maxRows?: number
  /** Caller-supplied id so the execution can be cancelled. */
  executionId?: string
  /** Send the text as a single batch instead of splitting it. */
  asSingleBatch?: boolean
  onMessage?: (message: ServerMessage) => void
}

export interface DbClient {
  readonly isConnected: boolean
  /** Local port of the SSH tunnel, when one is in use. */
  readonly tunnelPort: number | undefined
  readonly info: ServerInfo | null
  readonly currentConfig: ConnectionConfig

  connect(): Promise<ServerInfo>
  disconnect(): Promise<void>

  runScript(text: string, options?: ExecuteOptions): Promise<StatementResult[]>
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
