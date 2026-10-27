/** The IPC surface shared by the preload bridge and the renderer. */
import {
  AppSettings,
  AppliedChanges,
  ConnectionConfig,
  ConnectionStatus,
  DatabaseSummary,
  DefinitionSearchRequest,
  DefinitionSearchResult,
  ExportRequest,
  QueryExecutionResult,
  QueryHistoryEntry,
  RoutineObject,
  RoutineSource,
  RunQueryRequest,
  SavedConnection,
  SavedQuery,
  SchemaObject,
  Snippet,
  SerializedError,
  ServerActivity,
  SessionEvent,
  TableChangeSet,
  TableDataRequest,
  TableDataResponse,
  SsmConfig,
  TableForeignKey,
  TableStructure,
  SchemaObjectType
} from './types'
import type { ImportSummary } from './connectionTransfer'
import type { SnippetImportSummary } from './snippets'
import type { MenuRole } from './menu'
import type { UpdateState } from './updates'
import type { UiState, UiStatePatch } from './uiState'

/**
 * A tab being handed to a window of its own.
 *
 * Only what it takes to open the same thing again: a window has its own
 * connection pool and its own tab state, so nothing that belongs to the tab's
 * old window — staged edits, a result set, a scroll position — travels with it.
 */
export interface DetachedTab {
  kind: 'query' | 'table' | 'activity'
  connectionId: string
  title: string
  /** Query tabs only. */
  sql?: string
  /**
   * A query tab editing a routine: what it is, and the stored definition its
   * changes are marked against — without it, the text arrives with every
   * edit in it and nothing to say which lines they were.
   */
  routine?: RoutineSource
  /** Table tabs only. */
  schema?: string
  table?: string
  objectType?: SchemaObjectType
  view?: 'data' | 'structure'
  /**
   * How often the table — or the activity monitor — re-reads itself, when it
   * does: one being watched is the one most likely to be dragged out onto a
   * screen of its own.
   */
  autoRefresh?: number
  /** The activity monitor: whether it lists idle sessions too. */
  showIdle?: boolean
  /**
   * Columns taken out of its grid, by name. A table narrowed to the few
   * columns worth watching is the same table on another screen.
   */
  hiddenColumns?: string[]
}

/**
 * Why a window is being asked about its unsaved work: it is closing, or the
 * whole app is quitting.
 */
export type WindowCloseReason = 'close-window' | 'quit'

export interface DetachRequest {
  tab: DetachedTab
  /** Screen position the tab was dropped at, so the window opens under it. */
  position?: { x: number; y: number }
}

/**
 * A tab let go outside the strip it was dragged from.
 *
 * A renderer can see its own window and nothing else, so it reports where the
 * pointer was and the main process decides what that meant: a window under
 * that point takes the tab, and when there is none a window opens for it.
 */
export interface TabDropRequest {
  tab: DetachedTab
  /** Pointer position in screen coordinates when the drag ended. */
  point: { x: number; y: number }
}

export interface TabDropResult {
  /** True when an open window took the tab, false when one was opened for it. */
  attached: boolean
}

/** Result of the AWS SSM readiness check; mirrors `main/tunnel/ssmPreflight`. */
export interface SsmCheckResult {
  ok: boolean
  detail?: string
  error?: string
}

export interface SsmPreflight {
  awsCli: SsmCheckResult
  plugin: SsmCheckResult
  /** `ssoExpired` when signing in to AWS SSO again would fix it. */
  credentials: SsmCheckResult & { ssoExpired?: boolean }
}

/** What `aws sso login` asks the user to do, as `main/tunnel/ssoLogin` reads it. */
export interface SsoLoginPrompt {
  /** The page to sign in on. */
  url: string
  /** The device flow's code to enter there; null for the browser flow. */
  code: string | null
  /** The page as opened: with the code already filled in, where there is one. */
  openUrl: string
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
  connectionsExport: 'connections:export',
  connectionsImport: 'connections:import',
  connectionsTest: 'connections:test',
  ssmCheck: 'ssm:check',
  ssoLogin: 'ssm:ssoLogin',
  ssoLoginCancel: 'ssm:ssoLoginCancel',
  ssmInstances: 'ssm:instances',

  windowNew: 'window:new',
  windowDetachTab: 'window:detachTab',
  windowDropTab: 'window:dropTab',
  windowPendingTab: 'window:pendingTab',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  windowChrome: 'window:chrome',
  windowMenuRole: 'window:menuRole',
  windowUnsavedWork: 'window:unsavedWork',
  windowCloseAnswer: 'window:closeAnswer',

  shellOpenExternal: 'shell:openExternal',
  notifyQueryFinished: 'notify:queryFinished',

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
  dbSearchDefinitions: 'db:searchDefinitions',
  dbFindReferences: 'db:findReferences',
  dbActivity: 'db:activity',
  dbKillSession: 'db:killSession',

  queryRun: 'query:run',
  queryCancel: 'query:cancel',
  queryCloseSession: 'query:closeSession',

  historyList: 'history:list',
  historyClear: 'history:clear',

  savedQueriesList: 'savedQueries:list',
  savedQueriesSave: 'savedQueries:save',
  savedQueriesDelete: 'savedQueries:delete',
  snippetsList: 'snippets:list',
  snippetsSave: 'snippets:save',
  snippetsExport: 'snippets:export',
  snippetsImport: 'snippets:import',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  uiStateGet: 'uiState:get',
  uiStateUpdate: 'uiState:update',

  updatesState: 'updates:state',
  updatesCheck: 'updates:check',
  updatesInstall: 'updates:install',
  updatesInstalled: 'updates:installed',

  exportToFile: 'export:toFile',
  exportToClipboard: 'export:toClipboard',
  clipboardAwsCredentials: 'clipboard:awsCredentials',
  clipboardTablePlusUrl: 'clipboard:tablePlusUrl',
  clipboardReadText: 'clipboard:readText',

  dialogOpenFile: 'dialog:openFile',
  dialogSaveFile: 'dialog:saveFile',

  /** main -> renderer */
  eventStatusChanged: 'event:statusChanged',
  eventServerMessage: 'event:serverMessage',
  eventMenuAction: 'event:menuAction',
  eventWindowChrome: 'event:windowChrome',
  eventAttachTab: 'event:attachTab',
  eventCloseRequested: 'event:closeRequested',
  eventUpdateState: 'event:updateState',
  eventSessionChanged: 'event:sessionChanged',
  eventNotificationClicked: 'event:notificationClicked',
  eventSsoLoginPrompt: 'event:ssoLoginPrompt'
} as const

/**
 * What the custom title bar needs to know about its window. The frame is drawn
 * in the renderer, so the maximise button and the macOS traffic-light inset
 * have to be told when the real window changes state.
 */
export interface WindowChromeState {
  maximized: boolean
  fullScreen: boolean
  focused: boolean
}

export interface AppInfo {
  version: string
  electronVersion: string
  nodeVersion: string
  platform: string
  secretsAreOsBacked: boolean
  userDataPath: string
}

/** What a text file is saved as: a script, or an execution plan SSMS can open. */
export type SaveKind = 'sql' | 'sqlplan'

/** A desktop notification that a query tab's long run has ended. */
export interface QueryNotice {
  title: string
  body: string
  /** The tab that ran, brought forward when the notification is clicked. */
  tabId: string
}

/** What an export wrote, and where. */
export interface ConnectionExportResult {
  filePath: string
  connections: number
  groups: number
}

/** Uniform envelope so a thrown main-process error survives the IPC hop. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError }

export interface RendererApi {
  getAppInfo(): Promise<AppInfo>

  listConnections(): Promise<SavedConnection[]>
  saveConnection(input: Partial<ConnectionConfig> & { name: string }): Promise<SavedConnection>
  deleteConnection(id: string): Promise<boolean>
  duplicateConnection(id: string): Promise<SavedConnection | null>
  /** Writes the saved connections to a file the user picks. Null if cancelled. */
  exportConnections(): Promise<ConnectionExportResult | null>
  /** Reads connections out of a file the user picks. Null if cancelled. */
  importConnections(): Promise<ImportSummary | null>
  testConnection(input: Partial<ConnectionConfig>): Promise<ConnectionStatus>
  /** `connectionId` lets the check fall back to credentials already saved. */
  checkSsmPrerequisites(config: SsmConfig, connectionId?: string): Promise<SsmPreflight>
  /**
   * Runs `aws sso login` for the config's profile: true once the user has
   * finished signing in, false when it was cancelled. `loginId` names it for
   * `cancelSsoLogin` and for the `onSsoLoginPrompt` events it sends meanwhile.
   * `deviceCode` asks for a code to enter on any device rather than a page to
   * open on this one.
   */
  ssoLogin(config: SsmConfig, loginId: string, deviceCode?: boolean): Promise<boolean>
  /** Stops a sign-in, whose `ssoLogin` call then answers false. Nothing happens for one already over. */
  cancelSsoLogin(loginId: string): Promise<void>
  /** Instances in the configured region, so the bastion can be picked rather than typed. */
  listSsmInstances(config: SsmConfig, connectionId?: string): Promise<SsmInstanceList>

  openNewWindow(): Promise<void>
  /** Opens a window showing one tab, for a tab dragged out of this one. */
  detachTab(request: DetachRequest): Promise<void>
  /**
   * Hands a dragged tab to whichever window was under the pointer.
   *
   * Where no window was, it opens one — so a tab dragged onto another window
   * moves into it and a tab dragged onto the desktop still gets its own.
   */
  dropTab(request: TabDropRequest): Promise<TabDropResult>
  /**
   * The tab this window was opened to show, if it was opened for one.
   *
   * Consumed by the first caller: a window asks once, on startup, and a reload
   * must not reopen a tab the user has since closed.
   */
  takePendingTab(): Promise<DetachedTab | null>
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  getWindowChrome(): Promise<WindowChromeState>
  /**
   * Says whether this window holds work that closing it would lose. While it
   * does, the main process holds the window's close — and the app's quit —
   * and asks through `onCloseRequested` instead.
   */
  setUnsavedWork(unsaved: boolean): Promise<void>
  /** Answers `onCloseRequested`: true lets the window close, or the app quit. */
  answerCloseRequest(proceed: boolean): Promise<void>
  /** Runs a menu item the renderer cannot: clipboard, zoom, dev tools, quit. */
  runMenuRole(role: MenuRole): Promise<void>
  openExternal(url: string): Promise<void>
  /**
   * Shows a desktop notification for a query that finished in the
   * background. Where the desktop has no way to show one, nothing happens.
   */
  notifyQueryFinished(notice: QueryNotice): Promise<void>

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
  /** Text in the current database's procedures, functions, views and triggers. */
  searchDefinitions(request: DefinitionSearchRequest): Promise<DefinitionSearchResult>
  /** The procedures, functions, views and triggers that use a table, view or routine. */
  findReferences(connectionId: string, schema: string, name: string): Promise<DefinitionSearchResult>

  /** Every user session on the server and what it is running. */
  readActivity(connectionId: string): Promise<ServerActivity>
  /** Ends a session on the server. `confirmed`: the user was asked first. */
  killSession(connectionId: string, sessionId: number, confirmed?: boolean): Promise<void>

  fetchTableData(request: TableDataRequest): Promise<TableDataResponse>
  applyChanges(changeSet: TableChangeSet): Promise<AppliedChanges>
  /** `confirmed`: the user was asked first, which a confirm-writes connection needs. */
  truncateTable(
    connectionId: string,
    schema: string,
    table: string,
    confirmed?: boolean
  ): Promise<void>
  dropObject(
    connectionId: string,
    schema: string,
    name: string,
    type: 'table' | 'view',
    confirmed?: boolean
  ): Promise<void>

  runQuery(request: RunQueryRequest): Promise<QueryExecutionResult>
  cancelQuery(connectionId: string, executionId: string): Promise<boolean>
  /**
   * Ends a query tab's session, rolling back anything still open in it. The
   * window asks about an open transaction first; this does not.
   */
  closeSession(connectionId: string, sessionId: string): Promise<void>

  listHistory(search?: string): Promise<QueryHistoryEntry[]>
  clearHistory(): Promise<void>

  listSavedQueries(): Promise<SavedQuery[]>
  saveQuery(input: Partial<SavedQuery> & { name: string; sql: string }): Promise<SavedQuery>
  deleteSavedQuery(id: string): Promise<boolean>

  listSnippets(): Promise<Snippet[]>
  /** Replaces the whole list; refused, saving nothing, when one of them is not valid. */
  saveSnippets(snippets: Snippet[]): Promise<Snippet[]>
  /** Writes the list to a file the user picks; null when they cancel. */
  exportSnippets(): Promise<{ filePath: string; count: number } | null>
  /** Merges a file the user picks into the list; null when they cancel. */
  importSnippets(): Promise<{ summary: SnippetImportSummary; snippets: Snippet[] } | null>

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  /** Sizes and choices the workspace was left with, for a window to open with. */
  getUiState(): Promise<UiState>
  /** Remembers what a window changed; tables in the patch merge one by one. */
  updateUiState(patch: UiStatePatch): Promise<UiState>

  /** Where updating this copy of the app stands. */
  getUpdateState(): Promise<UpdateState>
  /**
   * Looks for a newer release now, whatever the setting says, and fetches what
   * it finds. Resolves with the state it leaves behind, failures included.
   */
  checkForUpdates(): Promise<UpdateState>
  /** Restarts into the downloaded update, asking about unsaved work first. */
  installUpdate(): Promise<void>
  /**
   * The version this copy has been updated to since it last ran, or null. It
   * is handed out once, so only the first window to ask says so.
   */
  takeInstalledUpdate(): Promise<string | null>

  exportToFile(request: ExportRequest): Promise<string | null>
  copyToClipboard(text: string): Promise<void>
  /**
   * The AWS credential block on the clipboard. Fails, saying why, when what is
   * there is not one — so nothing else that was copied reaches the window.
   */
  readAwsCredentialsFromClipboard(): Promise<string>
  /**
   * The SQL Server URL from TablePlus on the clipboard. Fails, saying why, when
   * what is there is not one — so nothing else that was copied, another
   * database's URL and its password included, reaches the window.
   */
  readTablePlusUrlFromClipboard(): Promise<string>
  /** The text on the clipboard, for a paste into a table's grid the user asked for. */
  readClipboardText(): Promise<string>

  openFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>
  readTextFile(filePath: string): Promise<string>
  /** `kind` names the dialog and its filter: SQL unless said otherwise. */
  saveTextFile(text: string, defaultPath?: string, kind?: SaveKind): Promise<string | null>

  onStatusChanged(handler: (status: ConnectionStatus) => void): () => void
  onMenuAction(handler: (action: string) => void): () => void
  onWindowChrome(handler: (state: WindowChromeState) => void): () => void
  /** A tab dragged onto this window from another one. */
  onAttachTab(handler: (tab: DetachedTab) => void): () => void
  /** The window is closing, or the app quitting, with unsaved work in it. */
  onCloseRequested(handler: (reason: WindowCloseReason) => void): () => void
  /** Updating has moved on: a check, a download, a failure. Sent to every window. */
  onUpdateState(handler: (state: UpdateState) => void): () => void
  /** A query tab's session moved with the sidebar's database, or was lost. */
  onSessionChanged(handler: (event: SessionEvent) => void): () => void
  /** A query notification was clicked: its window is in front, and this is its tab. */
  onNotificationClicked(handler: (tabId: string) => void): () => void
  onSsoLoginPrompt(handler: (event: SsoLoginPrompt & { loginId: string }) => void): () => void
}

declare global {
  interface Window {
    api: RendererApi
  }
}
