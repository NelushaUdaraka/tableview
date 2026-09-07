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
import { BrowserWindow, IpcMainInvokeEvent, app, clipboard, dialog, ipcMain, shell } from 'electron'
import {
  AppliedChanges,
  ConnectionConfig,
  ConnectionStatus,
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  ExportRequest,
  QueryExecutionResult,
  RunQueryRequest,
  SsmConfig,
  TableChangeSet,
  TableDataRequest
} from '../../shared/types'
import { AppInfo, CHANNELS, IpcResult, WindowChromeState } from '../../shared/ipc'
import { MenuRole } from '../../shared/menu'
import { EXPORT_EXTENSIONS, exportRows } from '../../shared/export'
import { credentialsToEnv, parseAwsCredentials } from '../../shared/aws/credentials'
import { ConnectionRegistry } from '../db/registry'
import { serializeError } from '../db/sqlserver/client'
import { AppData } from '../storage/appData'
import { runMenuRole } from '../menu'
import { chromeState } from '../window'
import { checkSsmPrerequisites } from '../tunnel/ssmPreflight'
import { listSsmInstances } from '../tunnel/ec2Instances'

export interface IpcContext {
  registry: ConnectionRegistry
  appData: AppData
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
  const { registry, appData, getWindow } = context

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

  // -- saved connections ----------------------------------------------------

  handle(CHANNELS.connectionsList, () => appData.listConnections())
  handle(CHANNELS.connectionsSave, (_call, input: Partial<ConnectionConfig> & { name: string }) =>
    appData.saveConnection(input)
  )
  handle(CHANNELS.connectionsDelete, async (call, id: string) => {
    await registry.close(call.scope, id)
    return appData.deleteConnection(id)
  })
  handle(CHANNELS.connectionsDuplicate, (_call, id: string) => appData.duplicateConnection(id))

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

      const status = await registry.open(call.scope, config)
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

  // -- table data -----------------------------------------------------------

  handle(CHANNELS.dbTableData, (call, request: TableDataRequest) =>
    registry.get(call.scope, request.connectionId).fetchTableData(request)
  )

  handle(CHANNELS.dbApplyChanges, (call, changeSet: TableChangeSet): Promise<AppliedChanges> =>
    registry.get(call.scope, changeSet.connectionId).applyChanges(changeSet)
  )

  handle(CHANNELS.dbTruncate, (call, id: string, schema: string, table: string) =>
    registry.get(call.scope, id).truncateTable(schema, table)
  )

  handle(
    CHANNELS.dbDrop,
    (call, id: string, schema: string, name: string, type: 'table' | 'view') =>
      registry.get(call.scope, id).dropObject(schema, name, type)
  )

  // -- query execution ------------------------------------------------------

  handle(CHANNELS.queryRun, async (call, request: RunQueryRequest): Promise<QueryExecutionResult> => {
    const client = registry.get(call.scope, request.connectionId)
    const executionId = request.executionId ?? randomUUID()
    const started = Date.now()

    const statements = await client.runScript(request.sql, {
      maxRows: request.maxRows,
      executionId,
      asSingleBatch: request.asSingleBatch,
      onMessage: (message) => {
        sendToWindow(call, CHANNELS.eventServerMessage, {
          connectionId: request.connectionId,
          executionId,
          message
        })
      }
    })

    const rowCount = statements.reduce(
      (total, statement) =>
        total + statement.resultSets.reduce((sum, set) => sum + set.rowCount, 0),
      0
    )
    const failed = statements.find((statement) => statement.error)

    appData.addHistory({
      connectionId: request.connectionId,
      connectionName: client.currentConfig.name,
      database: client.info?.currentDatabase,
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
      cancelled: false
    }
  })

  handle(CHANNELS.queryCancel, (call, connectionId: string, executionId: string) => {
    const client = registry.find(call.scope, connectionId)
    return client ? client.cancel(executionId) : false
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
  handle(CHANNELS.settingsUpdate, (_call, patch) => appData.updateSettings(patch))

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

  handle('file:readText', (_call, filePath: string) => fs.readFile(filePath, 'utf8'))

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
}

/** Set by main/index.ts so the renderer can ask for another window. */
let newWindowFactory: (() => void) | null = null

export function setWindowFactory(factory: () => void): void {
  newWindowFactory = factory
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
