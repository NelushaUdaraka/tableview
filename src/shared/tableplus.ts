/**
 * Bringing a connection over from TablePlus.
 *
 * TablePlus hands a saved connection out as a URL — right-click it, Copy as
 * URL — that carries the server, the login with its password, the database,
 * and the connection's name, colour, tag and safe mode as query parameters:
 *
 *   microsoftsqlserver://user:password@host:port/database?name=…&statusColor=…
 *   sqlserver+ssh://ssh_user:ssh_password@ssh_host:ssh_port/user:password@host:port/database?…
 *
 * Everything here is pure, so the main process runs the same check over the
 * clipboard that the window runs over what it is handed: only a SQL Server URL
 * from TablePlus gets past the main process, and nothing else that was copied
 * ever reaches the window.
 */
import { nearestSwatch } from './accent'
import { DEFAULT_SSH_CONFIG, type SshConfig } from './types'

/** What a SQL Server URL from TablePlus fills the New connection form with. */
export interface TablePlusConnection {
  name: string
  host: string
  port: number
  database: string
  username: string
  password: string
  /** A swatch's hex from ACCENT_SWATCHES, or '' for none. */
  color: string
  /** The TablePlus tag with its first letter capitalised, or '' for none. */
  group: string
  readOnly: boolean
  /** `{ ...DEFAULT_SSH_CONFIG }` when the URL has no tunnel. */
  ssh: SshConfig
}

export interface TablePlusImport {
  connection: TablePlusConnection
  /** The matched swatch's label, e.g. 'Blue'; null when no colour came across. */
  colourLabel: string | null
  /** A `+ssh` URL with `usePrivateKey=true`: the key file is not in the URL. */
  keyFileNeeded: boolean
}

const EMPTY =
  'The clipboard is empty. In TablePlus, right-click the connection and choose Copy as URL.'
const NOT_TABLEPLUS =
  'The clipboard does not hold a TablePlus URL. In TablePlus, right-click the connection and choose Copy as URL, then paste again.'

/** TablePlus's names for SQL Server. The Windows build writes the long one. */
const SQL_SERVER_SCHEMES = new Set(['sqlserver', 'microsoftsqlserver'])

/**
 * The other engines TablePlus's URLs name, from its docs.
 *
 * Known so that a refusal can say which database the URL was for — "that is a
 * PostgreSQL connection" is something to act on, "not a TablePlus URL" about
 * one copied out of TablePlus is not.
 */
const OTHER_ENGINES: Record<string, string> = {
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  redshift: 'Amazon Redshift',
  cockroach: 'CockroachDB',
  greenplum: 'Greenplum',
  vertica: 'Vertica',
  oracle: 'Oracle',
  clickhouse: 'ClickHouse',
  cassandra: 'Cassandra',
  redis: 'Redis',
  mongodb: 'MongoDB',
  elasticsearch: 'Elasticsearch',
  duckdb: 'DuckDB',
  d1: 'Cloudflare D1',
  cloudflared1: 'Cloudflare D1',
  sqlite: 'SQLite',
  snowflake: 'Snowflake',
  bigquery: 'BigQuery',
  libsql: 'libSQL'
}

/** Percent-decoded, keeping a `%` that is not an escape as it was written. */
function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function parse(text: string): URL {
  try {
    return new URL(text)
  } catch {
    throw new Error(NOT_TABLEPLUS)
  }
}

/** TablePlus's tag as a group heading: `production` files under "Production". */
function groupFrom(tag: string | null): string {
  const text = tag?.trim() ?? ''
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}

/** The SSH half of a `+ssh` URL, which is the URL's own authority. */
function tunnelFrom(url: URL, usesKey: boolean): SshConfig {
  const password = decode(url.password)
  const ssh: SshConfig = {
    ...DEFAULT_SSH_CONFIG,
    enabled: true,
    host: url.hostname,
    port: Number(url.port) || DEFAULT_SSH_CONFIG.port,
    username: decode(url.username)
  }
  // With a key, the password slot is the key's passphrase. The key file
  // itself never travels, so its path is left for the form to ask for.
  if (usesKey) {
    const key: SshConfig = { ...ssh, authMode: 'privateKey', privateKeyPath: '' }
    return password ? { ...key, passphrase: password } : key
  }
  // Neither a key nor a password: TablePlus leaves it to the SSH config and
  // agent, which is the closest thing TableView has.
  return password ? { ...ssh, authMode: 'password', password } : { ...ssh, authMode: 'agent' }
}

/**
 * Reads a URL copied out of TablePlus, refusing anything that is not one for
 * SQL Server.
 */
export function parseTablePlusUrl(text: string): TablePlusImport {
  const trimmed = text.trim()
  const scheme = /^([a-z][a-z0-9.+-]*):\/\//i.exec(trimmed)?.[1].toLowerCase()
  if (!scheme) throw new Error(NOT_TABLEPLUS)

  const tunnelled = scheme.endsWith('+ssh')
  const engine = tunnelled ? scheme.slice(0, -'+ssh'.length) : scheme
  if (!SQL_SERVER_SCHEMES.has(engine)) {
    const name = OTHER_ENGINES[engine]
    throw new Error(
      name ? `That is a ${name} connection. TableView only connects to SQL Server.` : NOT_TABLEPLUS
    )
  }

  const url = parse(trimmed)
  const params = url.searchParams
  const usesKey = params.get('usePrivateKey')?.toLowerCase() === 'true'
  // Through a tunnel, the URL's authority is the SSH server and the database's
  // own `user:password@host:port/database` is written out in its path.
  const server = tunnelled ? parse(`tableplus://${url.pathname.slice(1)}`) : url

  const host = server.hostname
  const swatch = nearestSwatch(params.get('statusColor'))
  return {
    connection: {
      name: params.get('name')?.trim() || host,
      host,
      port: Number(server.port) || 1433,
      database: decode(server.pathname.slice(1).split('/')[0]),
      username: decode(server.username),
      password: decode(server.password),
      color: swatch?.hex ?? '',
      group: groupFrom(params.get('env')),
      // TablePlus has no read-only mode: every safe mode but Silent warns or
      // asks before a query is sent, and the nearest TableView has to either
      // is refusing the writes outright.
      readOnly: Number(params.get('safeModeLevel')) > 0,
      ssh: tunnelled ? tunnelFrom(url, usesKey) : { ...DEFAULT_SSH_CONFIG }
    },
    colourLabel: swatch?.label ?? null,
    keyFileNeeded: tunnelled && usesKey
  }
}

/**
 * What the main process hands the window from the clipboard: a SQL Server URL
 * from TablePlus and nothing else. Whatever else was copied — a password, a
 * paragraph, another database's URL with its password in it — stays there.
 */
export function tablePlusUrlFromClipboard(text: string): string {
  const url = text.trim()
  if (!url) throw new Error(EMPTY)
  parseTablePlusUrl(url)
  return url
}
