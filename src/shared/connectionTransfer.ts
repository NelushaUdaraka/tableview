/**
 * Moving saved connections between machines.
 *
 * The file is the connection list without its secrets. Every password, SSH
 * key passphrase and AWS credential block stays in the vault it was written
 * to: an export is a plain file that lands in a download folder, gets mailed
 * to a colleague and ends up in a backup, and none of those are places for
 * the key to production. What travels instead is the *shape* of each
 * connection plus a note of which secrets it had, so the other end knows what
 * it will be asked for rather than discovering it at connect time.
 *
 * Everything here is pure and works off the redacted record the renderer
 * already holds, which is the other half of that guarantee: the code that
 * builds an export has never been handed a secret to leak.
 */
import type {
  ConnectionConfig,
  SavedConnection,
  SqlAuthType,
  SqlServerOptions,
  SshConfig,
  SsmConfig
} from './types'

export const CONNECTION_EXPORT_KIND = 'tableview/connections'
export const CONNECTION_EXPORT_VERSION = 1

/** What files said before TableView was renamed from Beekeeper Clone; still read. */
const LEGACY_EXPORT_KIND = 'beekeeper-clone/connections'

/** A secret the exporting machine held that the file deliberately leaves behind. */
export type MissingSecret = 'password' | 'sshPassword' | 'sshPassphrase' | 'awsCredentials'

export interface ExportedConnection {
  name: string
  group?: string
  color?: string
  host: string
  port: number
  database?: string
  authType: SqlAuthType
  username?: string
  domain?: string
  savePassword: boolean
  /** Travels: a connection marked read-only here should not arrive writable. */
  readOnly?: boolean
  options: SqlServerOptions
  ssh: Omit<SshConfig, 'password' | 'passphrase'>
  ssm: Omit<SsmConfig, 'credentials' | 'credentialSummary' | 'credentialsText'>
  createdAt?: string
  /** What the other end will have to be given before this one will open. */
  missingSecrets: MissingSecret[]
}

export interface ConnectionExportFile {
  kind: typeof CONNECTION_EXPORT_KIND
  version: number
  exportedAt: string
  connections: ExportedConnection[]
}

export interface ImportPlan {
  /** Connections to write, in the order the file lists them. */
  add: ExportedConnection[]
  /** Names already saved here, which are left alone. */
  skipped: string[]
}

export interface ImportSummary {
  added: string[]
  skipped: string[]
  /** Of the added ones, those that arrived without a secret they need. */
  needSecrets: string[]
}

/** The secrets a record had where it came from, in a stable order. */
function missingSecretsOf(connection: SavedConnection): MissingSecret[] {
  const missing: MissingSecret[] = []
  if (connection.hasSavedPassword) missing.push('password')
  if (connection.hasSavedSshPassword) missing.push('sshPassword')
  if (connection.hasSavedSshPassphrase) missing.push('sshPassphrase')
  if (connection.hasSavedAwsCredentials) missing.push('awsCredentials')
  return missing
}

/**
 * One connection, as it travels.
 *
 * Built by naming the fields rather than by deleting them from a spread: a
 * field added to `ConnectionConfig` later should have to be let into the file
 * on purpose, because the next one may well be another secret.
 */
export function toExportedConnection(connection: SavedConnection): ExportedConnection {
  const { password: _sshPassword, passphrase: _sshPassphrase, ...ssh } = connection.ssh ?? {}
  const {
    credentials: _credentials,
    credentialSummary: _summary,
    credentialsText: _text,
    ...ssm
  } = connection.ssm ?? {}

  return {
    name: connection.name,
    group: connection.group?.trim() || undefined,
    color: connection.color || undefined,
    host: connection.host,
    port: connection.port,
    database: connection.database || undefined,
    authType: connection.authType,
    username: connection.username || undefined,
    domain: connection.domain || undefined,
    savePassword: connection.savePassword,
    readOnly: connection.readOnly === true,
    options: { ...connection.options },
    ssh: { ...ssh } as ExportedConnection['ssh'],
    ssm: { ...ssm } as ExportedConnection['ssm'],
    createdAt: connection.createdAt,
    missingSecrets: missingSecretsOf(connection)
  }
}

export function buildExport(
  connections: readonly SavedConnection[],
  now: Date = new Date()
): ConnectionExportFile {
  return {
    kind: CONNECTION_EXPORT_KIND,
    version: CONNECTION_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    connections: connections.map(toExportedConnection)
  }
}

/** What the save dialog offers to call it. */
export function exportFileName(now: Date = new Date()): string {
  const [date] = now.toISOString().split('T')
  return `tableview-connections-${date}.json`
}

function fail(reason: string): never {
  throw new Error(reason)
}

function asRecord(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(reason)
  return value as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Reads a file back, refusing anything that is not one of ours.
 *
 * An import writes to the connection store, so the parsing is deliberately
 * unfriendly: the wrong file picked from a folder of JSON should say so by
 * name rather than quietly adding a row called "undefined".
 */
export function parseExportFile(contents: string): ConnectionExportFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    fail('That file is not JSON.')
  }

  const file = asRecord(parsed, 'That file does not hold a connection export.')
  if (file.kind !== CONNECTION_EXPORT_KIND && file.kind !== LEGACY_EXPORT_KIND) {
    fail('That file is not a TableView connection export.')
  }
  if (typeof file.version !== 'number' || file.version > CONNECTION_EXPORT_VERSION) {
    fail(`That export was written by a newer version (format ${String(file.version)}).`)
  }
  if (!Array.isArray(file.connections)) fail('That export has no connections in it.')

  const connections = file.connections.map((entry, index) => {
    const record = asRecord(entry, `Connection ${index + 1} in that file is not readable.`)
    const name = text(record.name)
    if (!name) fail(`Connection ${index + 1} in that file has no name.`)
    const host = text(record.host)
    if (!host) fail(`“${name}” in that file has no server.`)

    const port = Number(record.port)
    return {
      ...(record as unknown as ExportedConnection),
      name,
      host,
      port: Number.isFinite(port) && port > 0 ? port : 1433,
      group: text(record.group),
      // Files from before the setting existed have no flag, and mean writable.
      readOnly: record.readOnly === true,
      missingSecrets: Array.isArray(record.missingSecrets)
        ? (record.missingSecrets as MissingSecret[])
        : []
    }
  })

  return {
    kind: CONNECTION_EXPORT_KIND,
    version: file.version,
    exportedAt: text(file.exportedAt) ?? '',
    connections
  }
}

/**
 * Which of a file's connections are new here.
 *
 * A name that is already saved is left alone rather than brought in beside
 * itself: importing the same file twice is something people do — to pick up
 * the one connection they added since — and the cost of guessing wrong is a
 * list with everything in it twice.
 */
export function planImport(
  file: ConnectionExportFile,
  existing: readonly { name: string }[]
): ImportPlan {
  const taken = new Set(existing.map((entry) => entry.name.trim().toLowerCase()))
  const add: ExportedConnection[] = []
  const skipped: string[] = []

  for (const connection of file.connections) {
    const key = connection.name.trim().toLowerCase()
    // Also against the file's own earlier rows, so a file that repeats a name
    // does not import it twice.
    if (taken.has(key)) {
      skipped.push(connection.name)
      continue
    }
    taken.add(key)
    add.push(connection)
  }

  return { add, skipped }
}

/** An exported connection as `saveConnection` wants it. */
export function toSaveInput(
  connection: ExportedConnection
): Partial<ConnectionConfig> & { name: string } {
  return {
    name: connection.name,
    group: connection.group,
    color: connection.color ?? '',
    host: connection.host,
    port: connection.port,
    database: connection.database,
    authType: connection.authType,
    username: connection.username,
    domain: connection.domain,
    // Nothing to store yet, but the flag says whether to keep one when it is
    // typed in — the setting travels even though the secret does not.
    savePassword: connection.savePassword,
    readOnly: connection.readOnly === true,
    options: connection.options,
    ssh: connection.ssh as SshConfig,
    ssm: connection.ssm as SsmConfig,
    createdAt: connection.createdAt
  }
}
