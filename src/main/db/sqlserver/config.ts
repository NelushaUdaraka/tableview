/** Translation from the app's connection model into an mssql pool config. */
import { isIP } from 'node:net'
import type { config as MssqlConfig } from 'mssql'
import { DEFAULT_SQLSERVER_OPTIONS, type ConnectionConfig } from '../../../shared/types'

export interface TunnelEndpoint {
  localHost: string
  localPort: number
}

export class ConnectionConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionConfigError'
  }
}

/**
 * Builds the mssql config. When `tunnel` is supplied the connection is pointed
 * at the loopback listener instead of the real host.
 *
 * Named instances are resolved by the SQL Browser service over UDP 1434, which
 * a TCP port-forward cannot carry — so `instanceName` is dropped when tunnelling
 * and the explicit port is used instead.
 */
export function buildMssqlConfig(
  connection: ConnectionConfig,
  tunnel?: TunnelEndpoint | null
): MssqlConfig {
  if (!connection.host && !tunnel) {
    throw new ConnectionConfigError('A server host is required')
  }

  const options = connection.options
  const useTunnel = Boolean(tunnel)

  const base: Record<string, unknown> = {
    server: useTunnel ? tunnel!.localHost : connection.host,
    port: useTunnel ? tunnel!.localPort : connection.port,
    database: connection.database || undefined,
    connectionTimeout: options.connectTimeoutMs,
    requestTimeout: options.requestTimeoutMs,
    pool: {
      min: options.poolMin,
      max: Math.max(1, options.poolMax),
      idleTimeoutMillis: options.poolIdleTimeoutMs
    },
    options: {
      encrypt: options.encrypt,
      trustServerCertificate: options.trustServerCertificate,
      appName: options.applicationName || DEFAULT_SQLSERVER_OPTIONS.applicationName,
      readOnlyIntent: options.readOnlyIntent,
      // Dates come back as UTC so the renderer can format them predictably.
      useUTC: true,
      enableArithAbort: true,
      // Large results are streamed, so never buffer rows in the driver.
      rowCollectionOnDone: false,
      rowCollectionOnRequestCompletion: false
    }
  }

  // Through a tunnel the driver dials 127.0.0.1, which no certificate names;
  // the certificate is checked against the server it is really for. TLS has
  // no use for an IP address there, and is not given one.
  if (useTunnel && connection.host && !isIP(connection.host)) {
    ;(base.options as Record<string, unknown>).serverName = connection.host
  }

  if (options.instanceName && !useTunnel) {
    ;(base.options as Record<string, unknown>).instanceName = options.instanceName
    delete base.port
  }

  switch (connection.authType) {
    case 'sql': {
      if (!connection.username) throw new ConnectionConfigError('A login is required for SQL authentication')
      base.user = connection.username
      base.password = connection.password ?? ''
      break
    }
    case 'windows': {
      if (!connection.username) throw new ConnectionConfigError('A login is required for Windows authentication')
      base.user = connection.username
      base.password = connection.password ?? ''
      // mssql switches to NTLM as soon as `domain` is defined.
      base.domain = connection.domain || ''
      break
    }
    case 'azure-ad-password': {
      if (!connection.username) throw new ConnectionConfigError('A login is required for Azure AD authentication')
      base.authentication = {
        type: 'azure-active-directory-password',
        options: {
          userName: connection.username,
          password: connection.password ?? '',
          clientId: undefined,
          tenantId: connection.domain || undefined
        }
      }
      break
    }
    default:
      throw new ConnectionConfigError(`Unsupported authentication type: ${String(connection.authType)}`)
  }

  return base as unknown as MssqlConfig
}

/**
 * Never closed for idling: the largest delay a Node timer takes, about 24.8
 * days. A tab's session lasts as long as the tab, however long it sits.
 */
export const SESSION_IDLE_MS = 2_147_483_647

/**
 * The config for a query tab's session: one connection, held for the life of
 * the tab, in `database`.
 *
 * It is still an mssql pool — that is what the request code speaks — but one
 * that holds a single connection and never swaps it. mssql checks a pooled
 * connection before handing it out and, finding it dead, quietly makes a new
 * one; for a session that would run the next script with no temp tables, no
 * settings and none of the transaction the script was written to continue.
 * So validation is off, and `beforeConnect` sees every connection the pool
 * makes, which is how the session refuses a replacement.
 */
export function buildSessionConfig(
  connection: ConnectionConfig,
  tunnel: TunnelEndpoint | null | undefined,
  database: string,
  beforeConnect: (connection: unknown) => void
): MssqlConfig {
  const base = buildMssqlConfig({ ...connection, database }, tunnel) as unknown as Record<
    string,
    unknown
  >
  return {
    ...base,
    pool: { min: 0, max: 1, idleTimeoutMillis: SESSION_IDLE_MS },
    validateConnection: false,
    beforeConnect
  } as unknown as MssqlConfig
}

/** A stable label for logs and the window title. */
export function describeConnection(connection: ConnectionConfig): string {
  const instance = connection.options.instanceName ? `\\${connection.options.instanceName}` : ''
  const port = connection.options.instanceName ? '' : `:${connection.port}`
  const database = connection.database ? `/${connection.database}` : ''
  return `${connection.host}${instance}${port}${database}`
}
