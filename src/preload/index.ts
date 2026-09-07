/**
 * Context bridge.
 *
 * The renderer never touches ipcRenderer directly: it gets a typed façade whose
 * every call unwraps the main process's result envelope, rethrowing failures as
 * real Errors that keep the SQL Server error number, line and procedure.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, IpcResult, RendererApi } from '../shared/ipc'
import type {
  ConnectionStatus,
  ExportRequest,
  RunQueryRequest,
  TableChangeSet,
  TableDataRequest
} from '../shared/types'

/** Rethrows a failed envelope as an Error carrying the server's error fields. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (result.ok) return result.data
  const error = new Error(result.error.message)
  Object.assign(error, result.error)
  throw error
}

function subscribe(channel: string, handler: (payload: never) => void): () => void {
  const listener = (_event: unknown, payload: never): void => handler(payload)
  ipcRenderer.on(channel, listener as never)
  return () => {
    ipcRenderer.removeListener(channel, listener as never)
  }
}

const api: RendererApi = {
  getAppInfo: () => invoke(CHANNELS.appInfo),

  listConnections: () => invoke(CHANNELS.connectionsList),
  saveConnection: (input) => invoke(CHANNELS.connectionsSave, input),
  deleteConnection: (id) => invoke(CHANNELS.connectionsDelete, id),
  duplicateConnection: (id) => invoke(CHANNELS.connectionsDuplicate, id),
  testConnection: (input) => invoke(CHANNELS.connectionsTest, input),
  checkSsmPrerequisites: (config, connectionId) =>
    invoke(CHANNELS.ssmCheck, config, connectionId),
  listSsmInstances: (config, connectionId) =>
    invoke(CHANNELS.ssmInstances, config, connectionId),
  openNewWindow: () => invoke(CHANNELS.windowNew),

  connect: (connectionId, password) => invoke(CHANNELS.dbConnect, connectionId, password),
  disconnect: (connectionId) => invoke(CHANNELS.dbDisconnect, connectionId),
  status: (connectionId) => invoke(CHANNELS.dbStatus, connectionId),
  useDatabase: (connectionId, database) =>
    invoke(CHANNELS.dbUseDatabase, connectionId, database),

  listDatabases: (id) => invoke(CHANNELS.dbListDatabases, id),
  listSchemas: (id) => invoke(CHANNELS.dbListSchemas, id),
  listObjects: (id) => invoke(CHANNELS.dbListObjects, id),
  listRoutines: (id) => invoke(CHANNELS.dbListRoutines, id),
  getTableStructure: (id, schema, table) =>
    invoke(CHANNELS.dbTableStructure, id, schema, table),
  getInboundForeignKeys: (id, schema, table) =>
    invoke(CHANNELS.dbInboundForeignKeys, id, schema, table),
  getObjectDefinition: (id, schema, name) =>
    invoke(CHANNELS.dbObjectDefinition, id, schema, name),
  getAutocompleteSchema: (id) => invoke(CHANNELS.dbAutocomplete, id),

  fetchTableData: (request: TableDataRequest) => invoke(CHANNELS.dbTableData, request),
  applyChanges: (changeSet: TableChangeSet) => invoke(CHANNELS.dbApplyChanges, changeSet),
  truncateTable: (id, schema, table) => invoke(CHANNELS.dbTruncate, id, schema, table),
  dropObject: (id, schema, name, type) => invoke(CHANNELS.dbDrop, id, schema, name, type),

  runQuery: (request: RunQueryRequest) => invoke(CHANNELS.queryRun, request),
  cancelQuery: (connectionId, executionId) =>
    invoke(CHANNELS.queryCancel, connectionId, executionId),

  listHistory: (search) => invoke(CHANNELS.historyList, search),
  clearHistory: () => invoke(CHANNELS.historyClear),

  listSavedQueries: () => invoke(CHANNELS.savedQueriesList),
  saveQuery: (input) => invoke(CHANNELS.savedQueriesSave, input),
  deleteSavedQuery: (id) => invoke(CHANNELS.savedQueriesDelete, id),

  getSettings: () => invoke(CHANNELS.settingsGet),
  updateSettings: (patch) => invoke(CHANNELS.settingsUpdate, patch),

  exportToFile: (request: ExportRequest) => invoke(CHANNELS.exportToFile, request),
  copyToClipboard: (text) => invoke(CHANNELS.exportToClipboard, text),

  openFile: (filters) => invoke(CHANNELS.dialogOpenFile, filters),
  readTextFile: (filePath) => invoke('file:readText', filePath),
  saveTextFile: (text, defaultPath) => invoke(CHANNELS.dialogSaveFile, text, defaultPath),

  onStatusChanged: (handler: (status: ConnectionStatus) => void) =>
    subscribe(CHANNELS.eventStatusChanged, handler as (payload: never) => void),
  onMenuAction: (handler: (action: string) => void) =>
    subscribe(CHANNELS.eventMenuAction, handler as (payload: never) => void)
}

contextBridge.exposeInMainWorld('api', api)
