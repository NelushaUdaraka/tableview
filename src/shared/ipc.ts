/** The IPC surface shared by the preload bridge and the renderer. */
import {
  AppSettings,
  AppliedChanges,
  ConnectionConfig,
  ConnectionStatus,
  DatabaseSummary,
  ExportRequest,
  QueryExecutionResult,
  QueryHistoryEntry,
  RoutineObject,
  RunQueryRequest,
  SavedConnection,
  SavedQuery,
  SchemaObject,
  SerializedError,
  TableChangeSet,
  TableDataRequest,
  TableDataResponse,
  SsmConfig,
  TableForeignKey,
  TableStructure
} from './types'

/** Result of the AWS SSM readiness check; mirrors `main/tunnel/ssmPreflight`. */
export interface SsmCheckResult {
  ok: boolean
  detail?: string
  error?: string
}

export interface SsmPreflight {
  awsCli: SsmCheckResult
  plugin: SsmCheckResult
  credentials: SsmCheckResult
}

/**
 * One instance an SSM session could target, as `main/tunnel/ec2Instances`
 * reports it.
 *
 * Everything past the ID is decoration for the picker — it is there so a
 * bastion can be recognised by its Name tag and its state rather than by an ID
 * that changes with every deployment.
 */
export interface SsmInstance {
  instanceId: string
  /** The `Name` tag, when the instance has one. */
  name?: string
  /** EC2 lifecycle state; `unknown` for instances only Systems Manager knows about. */
  state: string
  instanceType?: string
  privateIpAddress?: string
  publicIpAddress?: string
  availabilityZone?: string
  vpcId?: string
  platform?: string
  launchTime?: string
  /** Registered with Systems Manager, so `start-session` can target it. */
  ssmManaged: boolean
  /** Agent reachability as SSM reports it: `Online`, `ConnectionLost`, `Inactive`. */
  ssmPingStatus?: string
}

export interface SsmInstanceList {
  /** The region the list was read from, resolved from the config or the credentials. */
  region?: string
  instances: SsmInstance[]
  /** Set when part of the lookup failed but the rest still produced a list. */
  warning?: string
}


export const CHANNELS = {
  appInfo: 'app:info',

  connectionsList: 'connections:list',
  connectionsSave: 'connections:save',
  connectionsDelete: 'connections:delete',
  connectionsDuplicate: 'connections:duplicate',
  connectionsTest: 'connections:test',
  ssmCheck: 'ssm:check',
  ssmInstances: 'ssm:instances',
  windowNew: 'window:new',

  dbConnect: 'db:connect',
  dbDisconnect: 'db:disconnect',
  dbStatus: 'db:status',
  dbUseDatabase: 'db:useDatabase',
  dbListDatabases: 'db:listDatabases',
  dbListSchemas: 'db:listSchemas',
  dbListObjects: 'db:listObjects',
  dbListRoutines: 'db:listRoutines',
  dbTableStructure: 'db:tableStructure',
  dbInboundForeignKeys: 'db:inboundForeignKeys',
  dbObjectDefinition: 'db:objectDefinition',
  dbTableData: 'db:tableData',
  dbApplyChanges: 'db:applyChanges',
  dbTruncate: 'db:truncate',
  dbDrop: 'db:drop',
  dbAutocomplete: 'db:autocomplete',

  queryRun: 'query:run',
  queryCancel: 'query:cancel',

  historyList: 'history:list',
  historyClear: 'history:clear',

  savedQueriesList: 'savedQueries:list',
  savedQueriesSave: 'savedQueries:save',
  savedQueriesDelete: 'savedQueries:delete',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  exportToFile: 'export:toFile',
  exportToClipboard: 'export:toClipboard',

  dialogOpenFile: 'dialog:openFile',
  dialogSaveFile: 'dialog:saveFile',

  /** main -> renderer */
  eventStatusChanged: 'event:statusChanged',
  eventServerMessage: 'event:serverMessage',
  eventMenuAction: 'event:menuAction'
} as const

export interface AppInfo {
  version: string
  electronVersion: string
  nodeVersion: string
  platform: string
  secretsAreOsBacked: boolean
  userDataPath: string
}

/** Uniform envelope so a thrown main-process error survives the IPC hop. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError }

export interface RendererApi {
  getAppInfo(): Promise<AppInfo>

  listConnections(): Promise<SavedConnection[]>
  saveConnection(input: Partial<ConnectionConfig> & { name: string }): Promise<SavedConnection>
  deleteConnection(id: string): Promise<boolean>
  duplicateConnection(id: string): Promise<SavedConnection | null>
  testConnection(input: Partial<ConnectionConfig>): Promise<ConnectionStatus>
  /** `connectionId` lets the check fall back to credentials already saved. */
  checkSsmPrerequisites(config: SsmConfig, connectionId?: string): Promise<SsmPreflight>
  /** Instances in the configured region, so the bastion can be picked rather than typed. */
  listSsmInstances(config: SsmConfig, connectionId?: string): Promise<SsmInstanceList>
  openNewWindow(): Promise<void>

  connect(connectionId: string, password?: string): Promise<ConnectionStatus>
  disconnect(connectionId: string): Promise<void>
  status(connectionId: string): Promise<ConnectionStatus>
  useDatabase(connectionId: string, database: string): Promise<ConnectionStatus>

  listDatabases(connectionId: string): Promise<DatabaseSummary[]>
  listSchemas(connectionId: string): Promise<string[]>
  listObjects(connectionId: string): Promise<SchemaObject[]>
  listRoutines(connectionId: string): Promise<RoutineObject[]>
  getTableStructure(connectionId: string, schema: string, table: string): Promise<TableStructure>
  getInboundForeignKeys(
    connectionId: string,
    schema: string,
    table: string
  ): Promise<TableForeignKey[]>
  getObjectDefinition(connectionId: string, schema: string, name: string): Promise<string | null>
  getAutocompleteSchema(connectionId: string): Promise<Record<string, string[]>>

  fetchTableData(request: TableDataRequest): Promise<TableDataResponse>
  applyChanges(changeSet: TableChangeSet): Promise<AppliedChanges>
  truncateTable(connectionId: string, schema: string, table: string): Promise<void>
  dropObject(
    connectionId: string,
    schema: string,
    name: string,
    type: 'table' | 'view'
  ): Promise<void>

  runQuery(request: RunQueryRequest): Promise<QueryExecutionResult>
  cancelQuery(connectionId: string, executionId: string): Promise<boolean>

  listHistory(search?: string): Promise<QueryHistoryEntry[]>
  clearHistory(): Promise<void>

  listSavedQueries(): Promise<SavedQuery[]>
  saveQuery(input: Partial<SavedQuery> & { name: string; sql: string }): Promise<SavedQuery>
  deleteSavedQuery(id: string): Promise<boolean>

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  exportToFile(request: ExportRequest): Promise<string | null>
  copyToClipboard(text: string): Promise<void>

  openFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>
  readTextFile(filePath: string): Promise<string>
  saveTextFile(text: string, defaultPath?: string): Promise<string | null>

  onStatusChanged(handler: (status: ConnectionStatus) => void): () => void
  onMenuAction(handler: (action: string) => void): () => void
}

declare global {
  interface Window {
    api: RendererApi
  }
}
