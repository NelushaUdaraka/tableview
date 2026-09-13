/**
 * Persistence for saved connections, query history, saved queries and settings.
 *
 * Secrets never reach the renderer: `listConnections` strips them and reports
 * only whether one is stored, and the connect path re-reads the plaintext here
 * in the main process.
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AppSettings,
  ConnectionConfig,
  DEFAULT_SETTINGS,
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  QueryHistoryEntry,
  SavedConnection,
  SavedQuery
} from '../../shared/types'
import { normalizeHex } from '../../shared/accent'
import { JsonStore } from './store'
import { SecretVault, isEncrypted } from './crypto'
import {
  isTemporary,
  maskAccessKeyId,
  parseAwsCredentials
} from '../../shared/aws/credentials'

const MAX_HISTORY = 2000

interface ConnectionsFile {
  version: number
  connections: ConnectionConfig[]
}

interface HistoryFile {
  version: number
  entries: QueryHistoryEntry[]
}

interface QueriesFile {
  version: number
  queries: SavedQuery[]
}

export class AppData {
  private readonly connections: JsonStore<ConnectionsFile>
  private readonly history: JsonStore<HistoryFile>
  private readonly queries: JsonStore<QueriesFile>
  private readonly settings: JsonStore<AppSettings>

  constructor(
    userDataDir: string,
    private readonly vault: SecretVault
  ) {
    this.connections = new JsonStore(path.join(userDataDir, 'connections.json'), () => ({
      version: 1,
      connections: []
    }))
    this.history = new JsonStore(path.join(userDataDir, 'history.json'), () => ({
      version: 1,
      entries: []
    }))
    this.queries = new JsonStore(path.join(userDataDir, 'saved-queries.json'), () => ({
      version: 1,
      queries: []
    }))
    this.settings = new JsonStore(path.join(userDataDir, 'settings.json'), () => ({
      ...DEFAULT_SETTINGS
    }))
  }

  get secretsAreOsBacked(): boolean {
    return this.vault.isBackedByOs
  }

  // -- connections ----------------------------------------------------------

  /** Connections with secrets removed, for the renderer. */
  listConnections(): SavedConnection[] {
    return this.connections.read().connections.map((connection) => this.redact(connection))
  }

  /** The full record, secrets decrypted — main process only. */
  getConnectionWithSecrets(id: string): ConnectionConfig | null {
    const stored = this.connections.read().connections.find((entry) => entry.id === id)
    if (!stored) return null
    return this.decryptSecrets(stored)
  }

  saveConnection(input: Partial<ConnectionConfig> & { name: string }): SavedConnection {
    const now = new Date().toISOString()
    const file = this.connections.read()
    const existingIndex = input.id
      ? file.connections.findIndex((entry) => entry.id === input.id)
      : -1
    const existing = existingIndex >= 0 ? file.connections[existingIndex] : null

    const merged: ConnectionConfig = {
      id: existing?.id ?? input.id ?? randomUUID(),
      name: input.name,
      // Omitted leaves the stored colour alone; empty clears it — the same
      // contract as a secret, because the picker has to be able to take a
      // colour back off a connection as well as put one on.
      color:
        input.color === undefined ? existing?.color : (normalizeHex(input.color) ?? undefined),
      engine: 'sqlserver',
      host: input.host ?? existing?.host ?? 'localhost',
      port: input.port ?? existing?.port ?? 1433,
      database: input.database ?? existing?.database,
      authType: input.authType ?? existing?.authType ?? 'sql',
      username: input.username ?? existing?.username,
      domain: input.domain ?? existing?.domain,
      savePassword: input.savePassword ?? existing?.savePassword ?? false,
      options: { ...DEFAULT_SQLSERVER_OPTIONS, ...existing?.options, ...input.options },
      ssh: { ...DEFAULT_SSH_CONFIG, ...existing?.ssh, ...input.ssh },
      ssm: { ...DEFAULT_SSM_CONFIG, ...existing?.ssm, ...input.ssm },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt
    }

    // An omitted password means "leave what is stored alone"; an empty string
    // means "clear it".
    merged.password = this.resolveSecret(
      input.password,
      existing?.password,
      merged.savePassword
    )
    merged.ssh.password = this.resolveSecret(
      input.ssh?.password,
      existing?.ssh?.password,
      merged.ssh.enabled && merged.ssh.authMode === 'password'
    )
    merged.ssh.passphrase = this.resolveSecret(
      input.ssh?.passphrase,
      existing?.ssh?.passphrase,
      merged.ssh.enabled && merged.ssh.authMode === 'privateKey'
    )

    this.applyAwsCredentials(merged, existing, input.ssm?.credentialsText)
    // Never persist the transient input field.
    delete merged.ssm.credentialsText

    const next = [...file.connections]
    if (existingIndex >= 0) next[existingIndex] = merged
    else next.push(merged)

    this.connections.write({ ...file, connections: next })
    return this.redact(merged)
  }

  /**
   * Applies a freshly pasted AWS block, or leaves the stored one alone.
   *
   * Undefined means "no change", an empty string means "forget them", and any
   * other text is parsed, summarised for display, and encrypted.
   */
  private applyAwsCredentials(
    merged: ConnectionConfig,
    existing: ConnectionConfig | null,
    text: string | undefined
  ): void {
    if (text === undefined) {
      merged.ssm.credentials = existing?.ssm?.credentials
      merged.ssm.credentialSummary = existing?.ssm?.credentialSummary
      return
    }
    if (text.trim() === '') {
      merged.ssm.credentials = undefined
      merged.ssm.credentialSummary = undefined
      return
    }

    const parsed = parseAwsCredentials(text)
    if (!parsed.credentials) {
      throw new Error(parsed.error ?? 'Those AWS credentials could not be read')
    }

    merged.ssm.credentials = this.vault.encrypt(JSON.stringify(parsed.credentials))
    merged.ssm.credentialSummary = {
      accessKeyId: maskAccessKeyId(parsed.credentials.accessKeyId),
      region: parsed.credentials.region,
      temporary: isTemporary(parsed.credentials),
      savedAt: new Date().toISOString(),
      expiresAt: parsed.credentials.expiration
    }
  }

  /** Encrypts a new secret, keeps the stored one, or clears it. */
  private resolveSecret(
    incoming: string | undefined,
    stored: string | undefined,
    shouldStore: boolean
  ): string | undefined {
    if (!shouldStore) return undefined
    if (incoming === undefined) return stored
    if (incoming === '') return undefined
    return this.vault.encrypt(incoming)
  }

  deleteConnection(id: string): boolean {
    const file = this.connections.read()
    const next = file.connections.filter((entry) => entry.id !== id)
    if (next.length === file.connections.length) return false
    this.connections.write({ ...file, connections: next })
    return true
  }

  duplicateConnection(id: string): SavedConnection | null {
    const source = this.connections.read().connections.find((entry) => entry.id === id)
    if (!source) return null
    const now = new Date().toISOString()
    const copy: ConnectionConfig = {
      ...source,
      id: randomUUID(),
      name: `${source.name} (copy)`,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: undefined
    }
    const file = this.connections.read()
    this.connections.write({ ...file, connections: [...file.connections, copy] })
    return this.redact(copy)
  }

  markConnectionUsed(id: string): void {
    const file = this.connections.read()
    const next = file.connections.map((entry) =>
      entry.id === id ? { ...entry, lastUsedAt: new Date().toISOString() } : entry
    )
    this.connections.write({ ...file, connections: next })
  }

  private redact(connection: ConnectionConfig): SavedConnection {
    const { password, ssh, ssm, ...rest } = connection
    return {
      ...rest,
      ssh: { ...ssh, password: undefined, passphrase: undefined },
      // The summary is safe to show; the encrypted block and any pasted text
      // stay in the main process.
      ssm: { ...ssm, credentials: undefined, credentialsText: undefined },
      hasSavedPassword: Boolean(password),
      hasSavedSshPassword: Boolean(ssh?.password),
      hasSavedSshPassphrase: Boolean(ssh?.passphrase),
      hasSavedAwsCredentials: Boolean(ssm?.credentials)
    }
  }

  private decryptSecrets(connection: ConnectionConfig): ConnectionConfig {
    const decrypt = (value: string | undefined): string | undefined => {
      if (!value) return undefined
      if (!isEncrypted(value)) return value
      try {
        return this.vault.decrypt(value)
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[appdata] could not decrypt a stored secret:', error)
        return undefined
      }
    }

    return {
      ...connection,
      password: decrypt(connection.password),
      ssh: {
        ...connection.ssh,
        password: decrypt(connection.ssh?.password),
        passphrase: decrypt(connection.ssh?.passphrase)
      },
      ssm: {
        ...connection.ssm,
        credentials: decrypt(connection.ssm?.credentials)
      }
    }
  }

  // -- query history --------------------------------------------------------

  addHistory(entry: Omit<QueryHistoryEntry, 'id'>): QueryHistoryEntry {
    const record: QueryHistoryEntry = { ...entry, id: randomUUID() }
    this.history.update((file) => ({
      ...file,
      entries: [record, ...file.entries].slice(0, MAX_HISTORY)
    }))
    return record
  }

  listHistory(search?: string, limit = 300): QueryHistoryEntry[] {
    const entries = this.history.read().entries
    if (!search) return entries.slice(0, limit)
    const needle = search.toLowerCase()
    return entries.filter((entry) => entry.sql.toLowerCase().includes(needle)).slice(0, limit)
  }

  clearHistory(): void {
    this.history.write({ version: 1, entries: [] })
  }

  // -- saved queries --------------------------------------------------------

  listSavedQueries(): SavedQuery[] {
    return [...this.queries.read().queries].sort((a, b) => a.name.localeCompare(b.name))
  }

  saveQuery(input: Partial<SavedQuery> & { name: string; sql: string }): SavedQuery {
    const now = new Date().toISOString()
    const file = this.queries.read()
    const index = input.id ? file.queries.findIndex((entry) => entry.id === input.id) : -1

    const record: SavedQuery = {
      id: index >= 0 ? file.queries[index].id : (input.id ?? randomUUID()),
      name: input.name,
      sql: input.sql,
      connectionId: input.connectionId,
      createdAt: index >= 0 ? file.queries[index].createdAt : now,
      updatedAt: now
    }

    const next = [...file.queries]
    if (index >= 0) next[index] = record
    else next.push(record)
    this.queries.write({ ...file, queries: next })
    return record
  }

  deleteSavedQuery(id: string): boolean {
    const file = this.queries.read()
    const next = file.queries.filter((entry) => entry.id !== id)
    if (next.length === file.queries.length) return false
    this.queries.write({ ...file, queries: next })
    return true
  }

  // -- settings -------------------------------------------------------------

  getSettings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...this.settings.read() }
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.getSettings(), ...patch }
    this.settings.write(next)
    return next
  }
}
