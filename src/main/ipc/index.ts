/**
 * IPC handler registration.
 *
 * Every handler returns an `IpcResult` envelope so a main-process failure
 * arrives in the renderer as a real Error with the server's error number and
 * line intact, instead of Electron's generic "Error invoking remote method".
 *
 * Handlers also receive a context describing *which window* called, because
 * several windows can be open at once: dialogs must attach to the right one,
 * events must be delivered to the right one, and each window's connections are
 * held in their own registry scope.
 */
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  BrowserWindow,
  IpcMainInvokeEvent,
  Notification,
  app,
  clipboard,
  dialog,
  ipcMain,
  shell
} from 'electron'
import {
  AppSettings,
  AppliedChanges,
  ConnectionConfig,
  ConnectionStatus,
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  DefinitionSearchRequest,
  ExportRequest,
  QueryExecutionResult,
  RunQueryRequest,
  ServerMessage,
  SessionEvent,
  SsmConfig,
  TableChangeSet,
  TableDataRequest
} from '../../shared/types'
import {
  AppInfo,
  CHANNELS,
  ConnectionExportResult,
  DetachRequest,
  DetachedTab,
  IpcResult,
  QueryNotice,
  TabDropRequest,
  TabDropResult,
  WindowChromeState
} from '../../shared/ipc'
import { exportFileName, type ImportSummary } from '../../shared/connectionTransfer'
import { MenuRole } from '../../shared/menu'
import { EXPORT_EXTENSIONS, exportRows } from '../../shared/export'
import { tablePlusUrlFromClipboard } from '../../shared/tableplus'
import { decodeText } from '../../shared/csv'
import type { UiStatePatch } from '../../shared/uiState'
import {
  credentialsFromClipboard,
  credentialsToEnv,
  parseAwsCredentials
} from '../../shared/aws/credentials'
import { ConnectionRegistry } from '../db/registry'
import type { SessionRun } from '../db/types'
import { enterRememberedDatabase } from '../db/lastDatabase'
import { serializeError } from '../db/sqlserver/client'
import { AppData } from '../storage/appData'
import { runMenuRole } from '../menu'
import { chromeState } from '../window'
import { closeGuard } from '../closeGuard'
import { checkSsmPrerequisites } from '../tunnel/ssmPreflight'
import { listSsmInstances } from '../tunnel/ec2Instances'
import { UpdateController } from '../updater'

export interface IpcContext {
  registry: ConnectionRegistry
  appData: AppData
  updates: UpdateController
  /**
   * Restarts into a downloaded update. It lives in main/index.ts, beside the
   * quit it is a kind of, because it has to ask every window first.
   */
  restartToUpdate: () => void
  /** Falls back to the focused window when a call has no identifiable sender. */
  getWindow: () => BrowserWindow | null
}

/** Per-call information about who is asking. */
interface CallContext {
  window: BrowserWindow | null
  /** Registry namespace — one per window. */
  scope: string
}

/** Connections opened by a window belong to that window alone. */
export function scopeForWindow(window: BrowserWindow | null): string {
  return window ? `win${window.id}` : 'detached'
}

export function registerIpcHandlers(context: IpcContext): void {
  const { registry, appData, updates, restartToUpdate, getWindow } = context

  // A connection that drops on its own has no call to return to, so the
  // registry reports it here and it is delivered to the window that owns it.
  registry.onStatusChange((scope, status) => {
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => scopeForWindow(candidate) === scope
    )
    if (window && !window.isDestroyed()) {
      window.webContents.send(CHANNELS.eventStatusChanged, status)
    }
  })

  // A tab's session that moved with the sidebar or was lost has no call to
  // return to either; it goes to the window whose tab it is.
  registry.onSessionChange((scope, connectionId, change) => {
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => scopeForWindow(candidate) === scope
    )
    if (window && !window.isDestroyed()) {
      const event: SessionEvent = { connectionId, ...change }
      window.webContents.send(CHANNELS.eventSessionChanged, event)
    }
  })

  function callContext(event: IpcMainInvokeEvent): CallContext {
    const window = BrowserWindow.fromWebContents(event.sender) ?? getWindow()
    return { window, scope: scopeForWindow(window) }
  }

  /** Wraps a handler so thrown errors come back as a structured failure. */
  function handle(
    channel: string,
    handler: (call: CallContext, ...args: any[]) => unknown
  ): void {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      try {
        const data = await handler(callContext(event), ...args)
        return { ok: true, data: data === undefined ? null : data }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[ipc] ${channel} failed:`, error)
        return { ok: false, error: serializeError(error) }
      }
    })
  }

  // -- app ------------------------------------------------------------------

  handle(CHANNELS.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    secretsAreOsBacked: appData.secretsAreOsBacked,
    userDataPath: app.getPath('userData')
  }))

  handle(CHANNELS.windowNew, () => {
    // The creator lives in main/index.ts; it registers itself here.
    if (!newWindowFactory) throw new Error('Window creation is not available')
    newWindowFactory()
  })

  /**
   * Opens a window for a tab that was dragged out of another one.
   *
   * The tab is remembered against the new window's contents rather than sent
   * to it: the renderer is not up yet, and a message to a window that is still
   * loading goes nowhere. It asks for it once it is ready.
   */
  handle(CHANNELS.windowDetachTab, (_call, request: DetachRequest) => {
    if (!newWindowFactory) throw new Error('Window creation is not available')
    const window = newWindowFactory(request.position)
    if (window) pendingTabs.set(window.webContents.id, request.tab)
  })

  /**
   * Takes a tab let go outside the window it was dragged from.
   *
   * Which window that landed on is a question only this side can answer — a
   * renderer sees its own window and nothing else — so the drop arrives as a
   * point on the screen. A window under it takes the tab and is brought to the
   * front; with nothing there, the tab gets a window of its own, which is the
   * drag that pulls a tab *out*. Either way the sender has already let the tab
   * go, so this must always end with it open somewhere.
   */
  handle(CHANNELS.windowDropTab, (call, request: TabDropRequest): TabDropResult => {
    const target = windowLocator?.(request.point, call.window) ?? null
    if (target && !target.isDestroyed()) {
      target.webContents.send(CHANNELS.eventAttachTab, request.tab)
      if (target.isMinimized()) target.restore()
      target.focus()
      return { attached: true }
    }

    if (!newWindowFactory) throw new Error('Window creation is not available')
    // Opened a little up and to the left of the pointer, so the new window's
    // strip lands under it rather than its top-left corner.
    const window = newWindowFactory({ x: request.point.x - 120, y: request.point.y - 20 })
    if (window) pendingTabs.set(window.webContents.id, request.tab)
    return { attached: false }
  })

  handle(CHANNELS.windowPendingTab, (call): DetachedTab | null => {
    const id = call.window?.webContents.id
    if (id === undefined) return null
    const tab = pendingTabs.get(id) ?? null
    // Taken, not read: reloading must not reopen a tab that has been closed.
    pendingTabs.delete(id)
    return tab
  })

  // -- window frame ---------------------------------------------------------
  // The title bar is drawn by the renderer, so the buttons on it come back
  // here to act on the real window.

  handle(CHANNELS.windowMinimize, (call) => {
    call.window?.minimize()
  })

  handle(CHANNELS.windowToggleMaximize, (call) => {
    const window = call.window
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  handle(CHANNELS.windowClose, (call) => {
    call.window?.close()
  })

  handle(CHANNELS.windowChrome, (call): WindowChromeState => chromeState(call.window))

  handle(CHANNELS.windowMenuRole, (call, role: MenuRole) => {
    runMenuRole(role, call.window)
  })

  // -- unsaved work ------------------------------------------------------------
  // The renderer knows what it has not saved; the guard holds the window's
  // close, and the app's quit, while it says so, and asks it.

  handle(CHANNELS.windowUnsavedWork, (call, unsaved: boolean) => {
    if (call.window) closeGuard.setUnsaved(call.window, unsaved === true)
  })

  handle(CHANNELS.windowCloseAnswer, (call, proceed: boolean) => {
    if (call.window) closeGuard.answer(call.window, proceed === true)
  })

  // -- saved connections ----------------------------------------------------

  handle(CHANNELS.connectionsList, () => appData.listConnections())
  handle(CHANNELS.connectionsSave, (_call, input: Partial<ConnectionConfig> & { name: string }) => {
    const saved = appData.saveConnection(input)
    // Read-only and confirm writes hold the moment they are saved, wherever
    // the connection is open, rather than from the next time it is opened.
    if (input.readOnly !== undefined || input.confirmWrites !== undefined) {
      registry.setWriteGuard(saved.id, {
        readOnly: saved.readOnly === true,
        confirmWrites: saved.confirmWrites === true
      })
    }
    return saved
  })
  handle(CHANNELS.connectionsDelete, async (call, id: string) => {
    await registry.close(call.scope, id)
    return appData.deleteConnection(id)
  })
  handle(CHANNELS.connectionsDuplicate, (_call, id: string) => appData.duplicateConnection(id))

  /**
   * Writes the connection list to a file, secrets left where they are.
   *
   * The payload is built in `appData` off the redacted records, so what is
   * serialised here has never held a password to begin with.
   */
  handle(CHANNELS.connectionsExport, async (call): Promise<ConnectionExportResult | null> => {
    const payload = appData.exportConnections()
    const result = await showSaveDialog(call, {
      title: 'Export connections',
      defaultPath: exportFileName(),
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null

    await fs.writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return {
      filePath: result.filePath,
      connections: payload.connections.length,
      groups: new Set(payload.connections.map((entry) => entry.group).filter(Boolean)).size
    }
  })

  handle(CHANNELS.connectionsImport, async (call): Promise<ImportSummary | null> => {
    const options = {
      title: 'Import connections',
      properties: ['openFile'] as ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const picked = call.window
      ? await dialog.showOpenDialog(call.window, options)
      : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return null

    return appData.importConnections(await fs.readFile(picked.filePaths[0], 'utf8'))
  })

  handle(CHANNELS.connectionsTest, (_call, input: Partial<ConnectionConfig>) =>
    registry.test(materialiseConfig(input, appData))
  )

  handle(CHANNELS.ssmCheck, async (_call, config: SsmConfig, connectionId?: string) =>
    checkSsmPrerequisites(config, resolveCredentialEnv(config, connectionId, appData) ?? {})
  )

  // The bastion's ID changes with every deployment, so the form offers the
  // account's instances instead of asking the user to remember one.
  handle(CHANNELS.ssmInstances, async (_call, config: SsmConfig, connectionId?: string) =>
    listSsmInstances(config, resolveCredentialEnv(config, connectionId, appData) ?? {})
  )

  // -- connection lifecycle -------------------------------------------------

  handle(
    CHANNELS.dbConnect,
    async (call, connectionId: string, password?: string): Promise<ConnectionStatus> => {
      const stored = appData.getConnectionWithSecrets(connectionId)
      if (!stored) throw new Error('No saved connection with that id')

      const config: ConnectionConfig = {
        ...stored,
        password: password !== undefined && password !== '' ? password : stored.password
      }

      const opened = await registry.open(call.scope, config)
      const remembered = appData.getUiState().databases[connectionId]
      const { status, forget } = await enterRememberedDatabase(opened, remembered, async (name) => {
        await registry.get(call.scope, connectionId).useDatabase(name)
        return registry.status(call.scope, connectionId)
      })
      if (forget) appData.updateUiState({ databases: { [connectionId]: '' } })
      if (status.state === 'connected') appData.markConnectionUsed(connectionId)
      sendToWindow(call, CHANNELS.eventStatusChanged, status)
      return status
    }
  )

  handle(CHANNELS.dbDisconnect, async (call, connectionId: string) => {
    await registry.close(call.scope, connectionId)
    sendToWindow(call, CHANNELS.eventStatusChanged, {
      connectionId,
      state: 'disconnected'
    } satisfies ConnectionStatus)
  })

  handle(CHANNELS.dbStatus, (call, connectionId: string) =>
    registry.status(call.scope, connectionId)
  )

  handle(CHANNELS.dbUseDatabase, async (call, connectionId: string, database: string) => {
    await registry.get(call.scope, connectionId).useDatabase(database)
    const status = registry.status(call.scope, connectionId)
    // Connecting again opens here. Back in the connection's own database,
    // there is nothing to remember: its settings already say so.
    const own = appData.listConnections().find((entry) => entry.id === connectionId)?.database ?? ''
    appData.updateUiState({ databases: { [connectionId]: database === own ? '' : database } })
    sendToWindow(call, CHANNELS.eventStatusChanged, status)
    return status
  })

  // -- schema ---------------------------------------------------------------

  handle(CHANNELS.dbListDatabases, (call, id: string) => registry.get(call.scope, id).listDatabases())
  handle(CHANNELS.dbListSchemas, (call, id: string) => registry.get(call.scope, id).listSchemas())
  handle(CHANNELS.dbListObjects, (call, id: string) => registry.get(call.scope, id).listObjects())
  handle(CHANNELS.dbListRoutines, (call, id: string) => registry.get(call.scope, id).listRoutines())
  handle(CHANNELS.dbTableStructure, (call, id: string, schema: string, table: string) =>
    registry.get(call.scope, id).getTableStructure(schema, table)
  )
  handle(CHANNELS.dbInboundForeignKeys, (call, id: string, schema: string, table: string) =>
    registry.get(call.scope, id).getInboundForeignKeys(schema, table)
  )
  handle(CHANNELS.dbObjectDefinition, (call, id: string, schema: string, name: string) =>
    registry.get(call.scope, id).getObjectDefinition(schema, name)
  )
  handle(CHANNELS.dbAutocomplete, (call, id: string) =>
    registry.get(call.scope, id).getAutocompleteSchema()
  )
  handle(CHANNELS.dbSearchDefinitions, (call, { connectionId, ...search }: DefinitionSearchRequest) =>
    registry.get(call.scope, connectionId).searchDefinitions(search)
  )
  handle(CHANNELS.dbFindReferences, (call, id: string, schema: string, name: string) =>
    registry.get(call.scope, id).findReferences(schema, name)
  )

  // -- server activity --------------------------------------------------------

  handle(CHANNELS.dbActivity, (call, id: string) => registry.get(call.scope, id).readActivity())

  handle(CHANNELS.dbKillSession, (call, id: string, sessionId: number, confirmed?: boolean) =>
    registry.get(call.scope, id).killSession(sessionId, confirmed)
  )

  // -- table data -----------------------------------------------------------

  handle(CHANNELS.dbTableData, (call, request: TableDataRequest) =>
    registry.get(call.scope, request.connectionId).fetchTableData(request)
  )

  handle(CHANNELS.dbApplyChanges, (call, changeSet: TableChangeSet): Promise<AppliedChanges> =>
    registry.get(call.scope, changeSet.connectionId).applyChanges(changeSet)
  )

  handle(
    CHANNELS.dbTruncate,
    (call, id: string, schema: string, table: string, confirmed?: boolean) =>
      registry.get(call.scope, id).truncateTable(schema, table, confirmed)
  )

  handle(
    CHANNELS.dbDrop,
    (call, id: string, schema: string, name: string, type: 'table' | 'view', confirmed?: boolean) =>
      registry.get(call.scope, id).dropObject(schema, name, type, confirmed)
  )

  // -- query execution ------------------------------------------------------

  handle(CHANNELS.queryRun, async (call, request: RunQueryRequest): Promise<QueryExecutionResult> => {
    const client = registry.get(call.scope, request.connectionId)
    const executionId = request.executionId ?? randomUUID()
    const started = Date.now()

    const options = {
      maxRows: request.maxRows,
      executionId,
      asSingleBatch: request.asSingleBatch,
      confirmedWrites: request.confirmedWrites,
      onMessage: (message: ServerMessage) => {
        sendToWindow(call, CHANNELS.eventServerMessage, {
          connectionId: request.connectionId,
          executionId,
          message
        })
      }
    }
    // A query tab runs on its own session; anything else on the shared pool.
    const run: SessionRun = request.sessionId
      ? await client.runInSession(request.sessionId, request.sql, {
          ...options,
          pinnedDatabase: request.pinnedDatabase
        })
      : { statements: await client.runScript(request.sql, options), session: null }
    const { statements } = run

    const rowCount = statements.reduce(
      (total, statement) =>
        total + statement.resultSets.reduce((sum, set) => sum + set.rowCount, 0),
      0
    )
    const failed = statements.find((statement) => statement.error)

    appData.addHistory({
      connectionId: request.connectionId,
      connectionName: client.currentConfig.name,
      // Where it ran: a tab's session can be somewhere the sidebar is not.
      database: run.session?.database ?? client.info?.currentDatabase,
      sql: request.sql,
      runAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      rowCount,
      success: !failed,
      errorMessage: failed?.error?.message
    })

    return {
      executionId,
      statements,
      totalDurationMs: Date.now() - started,
      cancelled: false,
      session: run.session ?? undefined,
      sessionLost: run.lost
    }
  })

  handle(CHANNELS.queryCancel, (call, connectionId: string, executionId: string) => {
    const client = registry.find(call.scope, connectionId)
    return client ? client.cancel(executionId) : false
  })

  // A connection already closed took its sessions with it: nothing to do.
  handle(CHANNELS.queryCloseSession, async (call, connectionId: string, sessionId: string) => {
    await registry.find(call.scope, connectionId)?.closeSession(sessionId)
  })

  // -- history & saved queries ----------------------------------------------

  handle(CHANNELS.historyList, (_call, search?: string) => appData.listHistory(search))
  handle(CHANNELS.historyClear, () => appData.clearHistory())
  handle(CHANNELS.savedQueriesList, () => appData.listSavedQueries())
  handle(CHANNELS.savedQueriesSave, (_call, input: { name: string; sql: string; id?: string }) =>
    appData.saveQuery(input)
  )
  handle(CHANNELS.savedQueriesDelete, (_call, id: string) => appData.deleteSavedQuery(id))

  // -- settings -------------------------------------------------------------

  handle(CHANNELS.settingsGet, () => appData.getSettings())
  handle(CHANNELS.settingsUpdate, (_call, patch: Partial<AppSettings>) => {
    const settings = appData.updateSettings(patch)
    // The switch takes effect at once: checks start or stop with it.
    updates.setEnabled(settings.autoUpdate)
    return settings
  })

  // -- the remembered layout -------------------------------------------------

  handle(CHANNELS.uiStateGet, () => appData.getUiState())
  handle(CHANNELS.uiStateUpdate, (_call, patch: UiStatePatch) => appData.updateUiState(patch))

  // -- updates --------------------------------------------------------------

  handle(CHANNELS.updatesState, () => updates.state)
  handle(CHANNELS.updatesCheck, () => updates.check())
  handle(CHANNELS.updatesInstall, () => restartToUpdate())
  handle(CHANNELS.updatesInstalled, () => updates.takeInstalled())

  // -- export & files -------------------------------------------------------

  handle(CHANNELS.exportToFile, async (call, request: ExportRequest): Promise<string | null> => {
    const text = exportRows(request.columns, request.rows, request)
    let target = request.filePath

    if (!target) {
      const extension = EXPORT_EXTENSIONS[request.format]
      const result = await showSaveDialog(call, {
        title: 'Export results',
        defaultPath: `${request.tableName ?? 'export'}.${extension}`,
        filters: [
          { name: request.format.toUpperCase(), extensions: [extension] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePath) return null
      target = result.filePath
    }

    await fs.writeFile(target, text, 'utf8')
    return target
  })

  handle(CHANNELS.exportToClipboard, (_call, text: string) => {
    clipboard.writeText(text)
  })

  // Read here rather than in the window, and only a credential block is
  // handed over: whatever else is on the clipboard stays there.
  handle(CHANNELS.clipboardAwsCredentials, async () =>
    credentialsFromClipboard(await clipboard.readText())
  )

  // The same for a connection copied out of TablePlus: a SQL Server URL is
  // handed over, and anything else stays on the clipboard.
  handle(CHANNELS.clipboardTablePlusUrl, async () =>
    tablePlusUrlFromClipboard(await clipboard.readText())
  )

  // Ctrl+V on a table's grid: the one place the window asks for whatever text
  // is there, because the user has just asked to paste it.
  handle(CHANNELS.clipboardReadText, () => clipboard.readText())

  handle(
    CHANNELS.dialogOpenFile,
    async (call, filters?: { name: string; extensions: string[] }[]): Promise<string | null> => {
      const options = {
        properties: ['openFile'] as ['openFile'],
        filters: filters ?? [
          { name: 'SQL', extensions: ['sql'] },
          { name: 'All files', extensions: ['*'] }
        ]
      }
      const result = call.window
        ? await dialog.showOpenDialog(call.window, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }
  )

  // Whatever the file was saved as — a CSV out of Excel is often UTF-16 or
  // Windows-1252 rather than UTF-8 — it arrives as text.
  handle('file:readText', async (_call, filePath: string) => decodeText(await fs.readFile(filePath)))

  handle(CHANNELS.dialogSaveFile, async (call, text: string, defaultPath?: string) => {
    const result = await showSaveDialog(call, {
      title: 'Save SQL',
      defaultPath: defaultPath ?? 'query.sql',
      filters: [
        { name: 'SQL', extensions: ['sql'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, text, 'utf8')
    return result.filePath
  })

  handle(CHANNELS.shellOpenExternal, (_call, url: string) => shell.openExternal(url))

  // -- notifications -----------------------------------------------------------
  // A long query that finished while its window was behind another says so on
  // the desktop. The window decides whether a run is worth it; this shows it,
  // and a click brings that window and the tab forward.

  handle(CHANNELS.notifyQueryFinished, (call, notice: QueryNotice) => {
    // Linux needs a notification daemon; where there is none, say nothing.
    if (!Notification.isSupported()) return
    const window = call.window
    try {
      const notification = new Notification({ title: notice.title, body: notice.body })
      // Held until it is done with: a notification that is collected loses
      // its click handler on some desktops.
      liveNotifications.add(notification)
      const release = (): void => {
        liveNotifications.delete(notification)
      }
      notification.on('click', () => {
        release()
        if (!window || window.isDestroyed()) return
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
        window.webContents.send(CHANNELS.eventNotificationClicked, notice.tabId)
      })
      notification.on('close', release)
      notification.on('failed', release)
      notification.show()
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[notify] could not show a notification:', error)
    }
  })
}

/** Notifications on screen, kept from the garbage collector until they go. */
const liveNotifications = new Set<Notification>()

/** Set by main/index.ts so the renderer can ask for another window. */
let newWindowFactory: ((position?: { x: number; y: number }) => BrowserWindow | null) | null = null

/**
 * Set by main/index.ts: which window, if any, a point on the screen is over.
 *
 * Only the window manager knows where the windows are, and it must not be
 * imported here — the handlers are what the renderer can reach, and they take
 * what they need through these two hooks.
 */
let windowLocator:
  | ((point: { x: number; y: number }, exclude: BrowserWindow | null) => BrowserWindow | null)
  | null = null

/** Tabs waiting for the window they were opened for to ask what it is showing. */
const pendingTabs = new Map<number, DetachedTab>()

export function setWindowFactory(
  factory: (position?: { x: number; y: number }) => BrowserWindow | null
): void {
  newWindowFactory = factory
}

export function setWindowLocator(
  locator: (point: { x: number; y: number }, exclude: BrowserWindow | null) => BrowserWindow | null
): void {
  windowLocator = locator
}

function showSaveDialog(
  call: CallContext,
  options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
  return call.window ? dialog.showSaveDialog(call.window, options) : dialog.showSaveDialog(options)
}

/** Events go only to the window that asked, never to every window. */
function sendToWindow(call: CallContext, channel: string, payload: unknown): void {
  if (call.window && !call.window.isDestroyed()) {
    call.window.webContents.send(channel, payload)
  }
}

/**
 * The AWS environment for an SSM session.
 *
 * Prefers a block the user has just pasted but not yet saved, so the
 * prerequisite check works while the connection dialog is still open; falls
 * back to what is stored against the connection.
 */
function resolveCredentialEnv(
  config: SsmConfig,
  connectionId: string | undefined,
  appData: AppData
): Record<string, string> | undefined {
  if (config.credentialSource !== 'pasted') return undefined

  if (config.credentialsText?.trim()) {
    const parsed = parseAwsCredentials(config.credentialsText)
    if (!parsed.credentials) throw new Error(parsed.error ?? 'Those AWS credentials could not be read')
    return credentialsToEnv(parsed.credentials)
  }

  if (!connectionId) return undefined
  const stored = appData.getConnectionWithSecrets(connectionId)
  if (!stored?.ssm?.credentials) return undefined
  try {
    return credentialsToEnv(JSON.parse(stored.ssm.credentials))
  } catch {
    return undefined
  }
}

/**
 * Fills a partial connection (from the "test connection" form) with defaults,
 * pulling saved secrets when the form left them blank.
 */
function materialiseConfig(input: Partial<ConnectionConfig>, appData: AppData): ConnectionConfig {
  const stored = input.id ? appData.getConnectionWithSecrets(input.id) : null
  const now = new Date().toISOString()

  const ssh = { ...DEFAULT_SSH_CONFIG, ...stored?.ssh, ...input.ssh }
  if (!input.ssh?.password && stored?.ssh?.password) ssh.password = stored.ssh.password
  if (!input.ssh?.passphrase && stored?.ssh?.passphrase) ssh.passphrase = stored.ssh.passphrase

  const ssm = { ...DEFAULT_SSM_CONFIG, ...stored?.ssm, ...input.ssm }
  // A block typed into the form but not yet saved should still be testable.
  if (input.ssm?.credentialsText?.trim()) {
    const parsed = parseAwsCredentials(input.ssm.credentialsText)
    if (!parsed.credentials) throw new Error(parsed.error ?? 'Those AWS credentials could not be read')
    ssm.credentials = JSON.stringify(parsed.credentials)
  } else if (stored?.ssm?.credentials) {
    ssm.credentials = stored.ssm.credentials
  }
  delete ssm.credentialsText

  return {
    id: input.id ?? 'ad-hoc',
    name: input.name ?? 'Test connection',
    engine: 'sqlserver',
    host: input.host ?? stored?.host ?? 'localhost',
    port: input.port ?? stored?.port ?? 1433,
    database: input.database ?? stored?.database,
    authType: input.authType ?? stored?.authType ?? 'sql',
    username: input.username ?? stored?.username,
    password: input.password || stored?.password,
    domain: input.domain ?? stored?.domain,
    savePassword: false,
    options: { ...DEFAULT_SQLSERVER_OPTIONS, ...stored?.options, ...input.options },
    ssh,
    ssm,
    createdAt: now,
    updatedAt: now
  }
}
