/** Translation from the app's connection model into an mssql pool config. */
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

/** A stable label for logs and the window title. */
export function describeConnection(connection: ConnectionConfig): string {
  const instance = connection.options.instanceName ? `\\${connection.options.instanceName}` : ''
  const port = connection.options.instanceName ? '' : `:${connection.port}`
  const database = connection.database ? `/${connection.database}` : ''
  return `${connection.host}${instance}${port}${database}`
}
