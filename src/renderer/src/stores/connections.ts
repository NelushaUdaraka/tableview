import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  ConnectionConfig,
  ConnectionSortDirection,
  ConnectionSortKey,
  ConnectionStatus,
  SavedConnection
} from '@shared/types'
import type { ConnectionExportResult } from '@shared/ipc'
import { writeModeOf, type WriteGuard } from '@shared/writeMode'
import type { ImportSummary } from '@shared/connectionTransfer'
import {
  defaultDirectionFor,
  normaliseSortDirection,
  normaliseSortKey,
  sortConnections
} from '../lib/sortConnections'
import { groupNames } from '../lib/connectionGroups'
import { useSettingsStore } from './settings'
import { api } from '../lib/api'

export const useConnectionStore = defineStore('connections', () => {
  const settings = useSettingsStore()
  const saved = ref<SavedConnection[]>([])
  const statuses = ref<Record<string, ConnectionStatus>>({})
  const activeId = ref<string | null>(null)
  const connectingId = ref<string | null>(null)

  const active = computed(() => saved.value.find((entry) => entry.id === activeId.value) ?? null)
  const activeStatus = computed<ConnectionStatus | null>(() =>
    activeId.value ? (statuses.value[activeId.value] ?? null) : null
  )
  const isConnected = computed(() => activeStatus.value?.state === 'connected')
  /**
   * Whether a connection is open as far as the workspace is concerned.
   *
   * Not the same as `isConnected`: a connection that drops mid-session is being
   * reopened, and throwing the user back to the connection screen would take
   * their tabs and staged edits with it. The session ends when they disconnect,
   * not when the socket does.
   */
  const inSession = computed(() => activeId.value !== null)

  /**
   * Whether the open connection refuses writes.
   *
   * The main process's word on the open connection, which is what it enforces,
   * rather than the saved list: the setting can be changed from another window
   * while this one stays open with the old one, and a window showing a lock
   * the connection is not keeping is worse than no lock at all.
   */
  const readOnly = computed(() => activeStatus.value?.readOnly === true)
  /**
   * Whether the open connection's confirm writes is on, on the same word. It
   * asks before a write only while read-only is off: see `writeMode`.
   */
  const confirmWrites = computed(() => activeStatus.value?.confirmWrites === true)
  /** What the open connection does with a write: refuse it, ask first, or send it. */
  const writeMode = computed(() =>
    writeModeOf({ readOnly: readOnly.value, confirmWrites: confirmWrites.value })
  )

  /**
   * The order the list is read in, as the reader last left it.
   *
   * Kept in the settings rather than here so it survives a restart: a list
   * that has to be re-sorted every morning is not sorted at all.
   */
  const sortKey = computed<ConnectionSortKey>(() =>
    normaliseSortKey(settings.settings.connectionSort)
  )
  const sortDirection = computed<ConnectionSortDirection>(() =>
    normaliseSortDirection(settings.settings.connectionSortDirection)
  )

  const sorted = computed(() => sortConnections(saved.value, sortKey.value, sortDirection.value))

  /** Sorts by `key`, opening it in the direction that key is worth reading in. */
  function setSortKey(key: ConnectionSortKey): Promise<void> {
    return settings.update({
      connectionSort: key,
      connectionSortDirection: defaultDirectionFor(key)
    })
  }

  /** Reads the same key the other way round. */
  function toggleSortDirection(): Promise<void> {
    return settings.update({
      connectionSortDirection: sortDirection.value === 'asc' ? 'desc' : 'asc'
    })
  }

  /** The groups in use, for the form's list and the row menu's "Move to". */
  const groups = computed(() => groupNames(saved.value))

  /**
   * Groups folded shut, by name.
   *
   * Kept for the session rather than in the settings: which groups are shut is
   * where the reader is looking right now, not how they want the list set up,
   * and a group that stayed shut across a restart would hide connections from
   * someone who had forgotten they closed it.
   */
  const collapsed = ref<string[]>([])

  const isCollapsed = (group: string): boolean => collapsed.value.includes(group)

  function toggleGroup(group: string): void {
    collapsed.value = isCollapsed(group)
      ? collapsed.value.filter((name) => name !== group)
      : [...collapsed.value, group]
  }

  async function load(): Promise<void> {
    saved.value = await api.listConnections()
  }

  async function save(
    input: Partial<ConnectionConfig> & { name: string }
  ): Promise<SavedConnection> {
    const record = await api.saveConnection(input)
    await load()
    return record
  }

  async function remove(id: string): Promise<void> {
    await api.deleteConnection(id)
    if (activeId.value === id) activeId.value = null
    delete statuses.value[id]
    await load()
  }

  /**
   * Copies a saved connection and hands the copy back.
   *
   * The caller gets the new record rather than just a refreshed list, because
   * duplicating is a step on the way to editing: the screen opens the copy in
   * the form straight afterwards.
   */
  async function duplicate(id: string): Promise<SavedConnection | null> {
    const copy = await api.duplicateConnection(id)
    await load()
    return copy
  }

  /**
   * Files a connection under a group, or takes it out of one.
   *
   * A partial save: everything not named here is left as the store has it,
   * which is what keeps a move from quietly clearing a password.
   */
  async function setGroup(connection: SavedConnection, group: string): Promise<void> {
    await save({ id: connection.id, name: connection.name, group })
  }

  /**
   * Sets read-only and confirm writes for a saved connection — and, through
   * the main process, wherever it is open, from the next statement on.
   *
   * A partial save, like a move between groups, so nothing else about the
   * connection is touched. The open connection's lock follows at once rather
   * than waiting on the status the main process sends after the save.
   */
  async function setWriteGuard(connection: SavedConnection, guard: WriteGuard): Promise<void> {
    await save({ id: connection.id, name: connection.name, ...guard })
    if (activeId.value === connection.id) setStatus({ ...statusFor(connection.id), ...guard })
  }

  /** Writes the list to a file. Null when the save dialog was dismissed. */
  function exportAll(): Promise<ConnectionExportResult | null> {
    return api.exportConnections()
  }

  /** Reads connections out of a file. Null when the dialog was dismissed. */
  async function importFile(): Promise<ImportSummary | null> {
    const summary = await api.importConnections()
    if (summary) await load()
    return summary
  }

  async function connect(id: string, password?: string): Promise<ConnectionStatus> {
    connectingId.value = id
    setStatus({ connectionId: id, state: 'connecting' })
    try {
      const status = await api.connect(id, password)
      setStatus(status)
      if (status.state === 'connected') activeId.value = id
      await load()
      return status
    } catch (error) {
      const status: ConnectionStatus = {
        connectionId: id,
        state: 'error',
        error: { message: error instanceof Error ? error.message : String(error) }
      }
      setStatus(status)
      return status
    } finally {
      connectingId.value = null
    }
  }

  /** Opens the active connection again after it dropped and stayed down. */
  async function reconnect(): Promise<ConnectionStatus | null> {
    const id = activeId.value
    return id ? connect(id) : null
  }

  async function disconnect(id: string): Promise<void> {
    await api.disconnect(id)
    setStatus({ connectionId: id, state: 'disconnected' })
    if (activeId.value === id) activeId.value = null
  }

  /**
   * Records a status, keeping what the last one said about read-only and
   * confirm writes when this one does not: a connection being put back, or one
   * that failed to come back, is still the read-only connection it was — and
   * the lock must not blink off while it is away.
   */
  function setStatus(status: ConnectionStatus): void {
    const previous = statuses.value[status.connectionId]
    const readOnly = status.readOnly ?? previous?.readOnly
    const confirmWrites = status.confirmWrites ?? previous?.confirmWrites
    const kept = { ...status }
    if (readOnly !== undefined) kept.readOnly = readOnly
    if (confirmWrites !== undefined) kept.confirmWrites = confirmWrites
    statuses.value = { ...statuses.value, [status.connectionId]: kept }
  }

  function statusFor(id: string): ConnectionStatus {
    return statuses.value[id] ?? { connectionId: id, state: 'disconnected' }
  }

  return {
    saved,
    sorted,
    groups,
    collapsed,
    isCollapsed,
    toggleGroup,
    setGroup,
    setWriteGuard,
    exportAll,
    importFile,
    sortKey,
    sortDirection,
    setSortKey,
    toggleSortDirection,
    statuses,
    activeId,
    active,
    activeStatus,
    isConnected,
    inSession,
    readOnly,
    confirmWrites,
    writeMode,
    connectingId,
    load,
    save,
    remove,
    duplicate,
    connect,
    reconnect,
    disconnect,
    setStatus,
    statusFor
  }
})
