/**
 * Tracks the live client for each open connection.
 *
 * Connections are scoped: every window gets its own namespace, so two windows
 * opening the same saved connection each get their own pool and tunnel instead
 * of silently evicting one another.
 */
import { ConnectionConfig, ConnectionStatus, SerializedError } from '../../shared/types'
import type { DbClient } from './types'
import { SqlServerClient, serializeError } from './sqlserver/client'

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
    await this.close(scope, config.id)

    this.connecting.add(key)
    this.errors.delete(key)

    // `create` is inside the try so an unsupported engine is reported the same
    // way as a refused login, rather than throwing past the caller.
    let client: DbClient | null = null
    try {
      client = this.create(config)
      const info = await client.connect()
      this.clients.set(key, client)
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
        tunnelPort: client.tunnelPort
      }
    }
    if (this.connecting.has(key)) return { connectionId, state: 'connecting' }
    const error = this.errors.get(key)
    if (error) return { connectionId, state: 'error', error }
    return { connectionId, state: 'disconnected' }
  }

  async close(scope: string, connectionId: string): Promise<void> {
    const key = entryKey(scope, connectionId)
    const client = this.clients.get(key)
    if (!client) return
    this.clients.delete(key)
    this.errors.delete(key)
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
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((key) => this.closeKey(key)))
  }

  private async closeKey(key: string): Promise<void> {
    const client = this.clients.get(key)
    this.clients.delete(key)
    this.errors.delete(key)
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
