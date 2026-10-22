/**
 * Tracks the live client for each open connection.
 *
 * Connections are scoped: every window gets its own namespace, so two windows
 * opening the same saved connection each get their own pool and tunnel instead
 * of silently evicting one another.
 */
import {
  ConnectionConfig,
  ConnectionStatus,
  SerializedError,
  type SessionState
} from '../../shared/types'
import type { ClientStateEvent, DbClient, SessionChange } from './types'
import { SqlServerClient, serializeError } from './sqlserver/client'

/**
 * Told about a connection that changed on its own, and which window's it is.
 *
 * The registry has no idea what a window is; the IPC layer turns the scope
 * back into one and delivers the status there.
 */
export type StatusListener = (scope: string, status: ConnectionStatus) => void

/**
 * Told about a query tab's session that changed on its own — moved by the
 * sidebar's database switch, or lost — and which window's connection it is on.
 */
export type SessionListener = (scope: string, connectionId: string, change: SessionChange) => void

/** Separator that cannot appear in a window scope or a connection uuid. */
const KEY_SEPARATOR = '::'

/** Namespaces an entry so identical connection ids in different windows differ. */
function entryKey(scope: string, connectionId: string): string {
  return `${scope}${KEY_SEPARATOR}${connectionId}`
}

export class ConnectionRegistry {
  private readonly clients = new Map<string, DbClient>()
  private readonly errors = new Map<string, SerializedError>()
  private readonly connecting = new Set<string>()
  /** Connections that dropped and are being reopened without being asked. */
  private readonly recovering = new Set<string>()
  private readonly statusListeners = new Set<StatusListener>()
  private readonly sessionListeners = new Set<SessionListener>()
  /**
   * The last read-only switch for each connection, numbered in order.
   *
   * `open` is handed a config read before it starts, and connecting can take
   * seconds — an SSM tunnel, a slow login — so a switch saved meanwhile has no
   * client to reach yet. The open looks here once it has one.
   */
  private readonly switches = new Map<string, { readOnly: boolean; order: number }>()
  private switchCount = 0
  /**
   * What the tabs' sessions had when their client was replaced by a reconnect,
   * by slot, until a client in that slot is open to take it — so a tab whose
   * transaction went is still refused its next run, rather than having it
   * committed on a new session.
   */
  private readonly lostSessions = new Map<string, Map<string, SessionState>>()

  /** Registered once by the IPC layer; returns a function that unregisters. */
  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Registered once by the IPC layer; returns a function that unregisters. */
  onSessionChange(listener: SessionListener): () => void {
    this.sessionListeners.add(listener)
    return () => this.sessionListeners.delete(listener)
  }

  /** Constructs the driver for a connection's engine. */
  private create(config: ConnectionConfig): DbClient {
    switch (config.engine) {
      case 'sqlserver':
        return new SqlServerClient(config)
      default:
        throw new Error(`Unsupported engine: ${String(config.engine)}`)
    }
  }

  async open(scope: string, config: ConnectionConfig): Promise<ConnectionStatus> {
    const key = entryKey(scope, config.id)
    const started = this.switchCount
    // Opening again ends the tabs' sessions on the client in the slot: what
    // they had goes on to the client that replaces it.
    const previous = this.clients.get(key)
    if (previous) {
      const lost = new Map([...(this.lostSessions.get(key) ?? []), ...previous.retireSessions()])
      if (lost.size > 0) this.lostSessions.set(key, lost)
    }
    await this.closeClient(key)

    this.connecting.add(key)
    this.errors.delete(key)

    // `create` is inside the try so an unsupported engine is reported the same
    // way as a refused login, rather than throwing past the caller.
    let client: DbClient | null = null
    try {
      client = this.create(config)
      const info = await client.connect()
      // Switched while it was opening: `config` is from before the switch.
      const switched = this.switches.get(config.id)
      if (switched && switched.order > started) client.setReadOnly(switched.readOnly)
      this.clients.set(key, client)
      this.recovering.delete(key)
      const lost = this.lostSessions.get(key)
      this.lostSessions.delete(key)
      if (lost) client.adoptLostSessions(lost)
      // From here the client can report a drop nobody asked about.
      client.onStateChange((event) => this.onClientState(scope, config.id, event))
      // …and a tab's session that moved or was lost.
      const opened = client
      client.onSessionChange((change) => {
        // Only the client in the slot speaks for its window's tabs.
        if (this.clients.get(key) !== opened) return
        for (const listener of this.sessionListeners) listener(scope, config.id, change)
      })
      return {
        connectionId: config.id,
        state: 'connected',
        serverVersion: info.productVersion,
        serverEdition: info.edition,
        currentDatabase: info.currentDatabase,
        currentUser: info.login,
        tunnelPort: client.tunnelPort,
        readOnly: client.currentConfig.readOnly === true
      }
    } catch (error) {
      const serialized = serializeError(error)
      this.errors.set(key, serialized)
      await client?.disconnect().catch(() => undefined)
      return { connectionId: config.id, state: 'error', error: serialized }
    } finally {
      this.connecting.delete(key)
    }
  }

  /** Opens a throwaway connection purely to check the settings work. */
  async test(config: ConnectionConfig): Promise<ConnectionStatus> {
    let client: DbClient | null = null
    try {
      client = this.create(config)
      const info = await client.connect()
      return {
        connectionId: config.id,
        state: 'connected',
        serverVersion: info.productVersion,
        serverEdition: info.edition,
        currentDatabase: info.currentDatabase,
        currentUser: info.login,
        tunnelPort: client.tunnelPort
      }
    } catch (error) {
      return { connectionId: config.id, state: 'error', error: serializeError(error) }
    } finally {
      await client?.disconnect().catch(() => undefined)
    }
  }

  /**
   * Turns a client's own report into a status and passes it on.
   *
   * A reconnection reads as `connecting` with the reason attached, so the
   * window can say what went and that it is being dealt with, rather than
   * dropping the user back to the connection screen.
   */
  private onClientState(scope: string, connectionId: string, event: ClientStateEvent): void {
    const key = entryKey(scope, connectionId)
    // A client that has been replaced or closed no longer speaks for this slot.
    if (!this.clients.has(key)) return

    let status: ConnectionStatus
    if (event.state === 'connected') {
      this.recovering.delete(key)
      this.errors.delete(key)
      status = this.status(scope, connectionId)
    } else if (event.state === 'reconnecting') {
      this.recovering.add(key)
      status = {
        connectionId,
        state: 'connecting',
        error: event.error ? serializeError(event.error) : undefined
      }
    } else {
      this.recovering.delete(key)
      status = {
        connectionId,
        state: 'disconnected',
        error: event.error ? serializeError(event.error) : undefined
      }
    }

    for (const listener of this.statusListeners) listener(scope, status)
  }

  get(scope: string, connectionId: string): DbClient {
    const client = this.clients.get(entryKey(scope, connectionId))
    if (!client) throw new Error('That connection is not open. Connect first.')
    return client
  }

  find(scope: string, connectionId: string): DbClient | undefined {
    return this.clients.get(entryKey(scope, connectionId))
  }

  status(scope: string, connectionId: string): ConnectionStatus {
    const key = entryKey(scope, connectionId)
    const client = this.clients.get(key)
    if (client?.isConnected) {
      return {
        connectionId,
        state: 'connected',
        serverVersion: client.info?.productVersion,
        serverEdition: client.info?.edition,
        currentDatabase: client.info?.currentDatabase,
        currentUser: client.info?.login,
        tunnelPort: client.tunnelPort,
        readOnly: client.currentConfig.readOnly === true
      }
    }
    // A connection being reopened after a drop is on its way back, not gone —
    // and is still whichever way read-only was left.
    if (this.connecting.has(key) || this.recovering.has(key)) {
      return client
        ? { connectionId, state: 'connecting', readOnly: client.currentConfig.readOnly === true }
        : { connectionId, state: 'connecting' }
    }
    const error = this.errors.get(key)
    if (error) return { connectionId, state: 'error', error }
    return { connectionId, state: 'disconnected' }
  }

  /**
   * Turns read-only on or off wherever a connection is open.
   *
   * It is one setting on one saved connection, so every window that has it
   * open switches with it, and each is told — the one that asked and any
   * other — so no window shows a lock its connection is no longer keeping.
   * A window whose connection was already that way hears nothing, and one
   * still connecting takes the switch when it opens.
   */
  setReadOnly(connectionId: string, readOnly: boolean): void {
    this.switches.set(connectionId, { readOnly, order: ++this.switchCount })
    for (const [key, client] of this.clients) {
      const at = key.indexOf(KEY_SEPARATOR)
      if (key.slice(at + KEY_SEPARATOR.length) !== connectionId) continue
      if ((client.currentConfig.readOnly === true) === readOnly) continue
      client.setReadOnly(readOnly)
      const scope = key.slice(0, at)
      const status = this.status(scope, connectionId)
      for (const listener of this.statusListeners) listener(scope, status)
    }
  }

  async close(scope: string, connectionId: string): Promise<void> {
    const key = entryKey(scope, connectionId)
    // Closed on purpose: its tabs closed first, and what they lost with them.
    this.lostSessions.delete(key)
    await this.closeClient(key)
  }

  /** Takes the slot's client out and disconnects it. */
  private async closeClient(key: string): Promise<void> {
    const client = this.clients.get(key)
    if (!client) return
    this.clients.delete(key)
    this.errors.delete(key)
    this.recovering.delete(key)
    client.onStateChange(null)
    client.onSessionChange(null)
    await client.disconnect().catch(() => undefined)
  }

  /** Closes everything a window owned, for when that window goes away. */
  async closeScope(scope: string): Promise<void> {
    const prefix = `${scope}${KEY_SEPARATOR}`
    const keys = [...this.clients.keys()].filter((key) => key.startsWith(prefix))
    await Promise.all(keys.map((key) => this.closeKey(key)))

    // Remembered failures belong to the window too; without this they would
    // accumulate for the life of the process as windows come and go.
    for (const key of [...this.errors.keys()]) {
      if (key.startsWith(prefix)) this.errors.delete(key)
    }
    for (const key of [...this.connecting]) {
      if (key.startsWith(prefix)) this.connecting.delete(key)
    }
    for (const key of [...this.recovering]) {
      if (key.startsWith(prefix)) this.recovering.delete(key)
    }
    for (const key of [...this.lostSessions.keys()]) {
      if (key.startsWith(prefix)) this.lostSessions.delete(key)
    }
  }

  async closeAll(): Promise<void> {
    this.lostSessions.clear()
    await Promise.all([...this.clients.keys()].map((key) => this.closeKey(key)))
  }

  private async closeKey(key: string): Promise<void> {
    const client = this.clients.get(key)
    this.clients.delete(key)
    this.errors.delete(key)
    this.recovering.delete(key)
    client?.onStateChange(null)
    client?.onSessionChange(null)
    await client?.disconnect().catch(() => undefined)
  }

  /** Connection ids currently open, across every scope. */
  openConnectionIds(): string[] {
    return [...this.clients.keys()].map((key) => key.slice(key.indexOf(KEY_SEPARATOR) + KEY_SEPARATOR.length))
  }

  get openCount(): number {
    return this.clients.size
  }
}
