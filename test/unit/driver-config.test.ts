import { describe, expect, it } from 'vitest'
import {
  ConnectionConfigError,
  SESSION_IDLE_MS,
  buildMssqlConfig,
  buildSessionConfig,
  describeConnection
} from '../../src/main/db/sqlserver/config'
import {
  declarationOf,
  isReadOnlyType,
  jsKindOf,
  renderDriverType
} from '../../src/main/db/sqlserver/types'
import { mapDriverColumns, serializeError } from '../../src/main/db/sqlserver/client'
import { untrustedCertificate } from '../../src/main/db/sqlserver/errors'
import {
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  type ConnectionConfig
} from '../../src/shared/types'

/** mssql's exported `config` type has no index signature, so widen once here. */
function built(connection: ConnectionConfig, tunnel?: { localHost: string; localPort: number }) {
  return buildMssqlConfig(connection, tunnel) as unknown as Record<string, unknown> & {
    options: Record<string, unknown>
    pool: { max: number; min: number }
    authentication?: { type: string; options: Record<string, unknown> }
  }
}

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'c1',
    name: 'Test',
    engine: 'sqlserver',
    host: 'db.example.com',
    port: 1433,
    database: 'app',
    authType: 'sql',
    username: 'sa',
    password: 'secret',
    savePassword: true,
    options: { ...DEFAULT_SQLSERVER_OPTIONS },
    ssh: { ...DEFAULT_SSH_CONFIG },
    ssm: { ...DEFAULT_SSM_CONFIG },
    createdAt: '',
    updatedAt: '',
    ...overrides
  }
}

describe('buildMssqlConfig', () => {
  it('maps the basics', () => {
    const cfg = built(config())
    expect(cfg.server).toBe('db.example.com')
    expect(cfg.port).toBe(1433)
    expect(cfg.database).toBe('app')
    expect(cfg.user).toBe('sa')
    expect(cfg.password).toBe('secret')
  })

  it('carries the TLS and timeout options through', () => {
    const cfg = built(
      config({
        options: {
          ...DEFAULT_SQLSERVER_OPTIONS,
          encrypt: false,
          trustServerCertificate: false,
          connectTimeoutMs: 5000,
          requestTimeoutMs: 7000,
          applicationName: 'My App',
          readOnlyIntent: true
        }
      })
    )
    expect(cfg.options.encrypt).toBe(false)
    expect(cfg.options.trustServerCertificate).toBe(false)
    expect(cfg.options.appName).toBe('My App')
    expect(cfg.options.readOnlyIntent).toBe(true)
    expect(cfg.options.useUTC).toBe(true)
    expect(cfg.connectionTimeout).toBe(5000)
    expect(cfg.requestTimeout).toBe(7000)
  })

  it('names the app to SQL Server when the connection leaves the name blank', () => {
    const cfg = built(config({ options: { ...DEFAULT_SQLSERVER_OPTIONS, applicationName: '' } }))
    expect(cfg.options.appName).toBe('TableView')
  })

  it('sets domain for Windows auth, which switches mssql to NTLM', () => {
    const cfg = built(config({ authType: 'windows', username: 'dev', domain: 'CORP' }))
    expect(cfg.domain).toBe('CORP')
    expect(cfg.user).toBe('dev')
  })

  it('defines domain even when blank, so NTLM is still selected', () => {
    expect('domain' in built(config({ authType: 'windows', username: 'dev' }))).toBe(true)
  })

  it('builds an Azure AD authentication block', () => {
    const cfg = built(
      config({ authType: 'azure-ad-password', username: 'user@tenant', domain: 'tenant-id' })
    )
    expect(cfg.authentication?.type).toBe('azure-active-directory-password')
    expect(cfg.authentication?.options.userName).toBe('user@tenant')
    expect(cfg.authentication?.options.tenantId).toBe('tenant-id')
  })

  it('uses the named instance and drops the port', () => {
    const cfg = built(config({ options: { ...DEFAULT_SQLSERVER_OPTIONS, instanceName: 'SQLEXPRESS' } }))
    expect(cfg.options.instanceName).toBe('SQLEXPRESS')
    expect('port' in cfg).toBe(false)
  })

  it('points at the tunnel instead of the real host', () => {
    const cfg = built(config(), { localHost: '127.0.0.1', localPort: 54321 })
    expect(cfg.server).toBe('127.0.0.1')
    expect(cfg.port).toBe(54321)
  })

  // Through a tunnel the driver dials 127.0.0.1, which no certificate names.
  it('checks the certificate against the real host when tunnelling', () => {
    const tunnel = { localHost: '127.0.0.1', localPort: 54321 }
    expect(built(config(), tunnel).options.serverName).toBe('db.example.com')
    expect(built(config()).options.serverName).toBeUndefined()
    // TLS takes no IP address as a server name.
    expect(built(config({ host: '10.0.0.5' }), tunnel).options.serverName).toBeUndefined()
  })

  it('ignores the named instance when tunnelling, since SQL Browser is UDP', () => {
    const cfg = built(
      config({ options: { ...DEFAULT_SQLSERVER_OPTIONS, instanceName: 'SQLEXPRESS' } }),
      { localHost: '127.0.0.1', localPort: 54321 }
    )
    expect(cfg.options.instanceName).toBeUndefined()
    expect(cfg.port).toBe(54321)
  })

  it('never lets the pool max fall below one', () => {
    expect(built(config({ options: { ...DEFAULT_SQLSERVER_OPTIONS, poolMax: 0 } })).pool.max).toBe(1)
  })

  it('requires the fields it cannot invent', () => {
    expect(() => buildMssqlConfig(config({ host: '' }))).toThrow(ConnectionConfigError)
    expect(() => buildMssqlConfig(config({ username: '' }))).toThrow(/login is required/)
    expect(() => buildMssqlConfig(config({ authType: 'windows', username: '' }))).toThrow(
      /login is required/
    )
    // @ts-expect-error deliberately invalid
    expect(() => buildMssqlConfig(config({ authType: 'kerberos' }))).toThrow(
      /Unsupported authentication type/
    )
  })

  it('omits an empty database rather than sending a blank name', () => {
    expect(built(config({ database: '' })).database).toBeUndefined()
  })
})

/**
 * A query tab's session is one connection held for the tab's life. The pool
 * that carries it must not close it for idling, and must not quietly swap a
 * dead one for a fresh one: the next script would run on a new session.
 */
describe('buildSessionConfig', () => {
  it('holds one connection, never closes it for idling, and does not let the pool swap it', () => {
    const hook = (): void => undefined
    const built = buildSessionConfig(
      config(),
      { localHost: '127.0.0.1', localPort: 54321 },
      'reports',
      hook
    ) as unknown as Record<string, unknown> & { options: Record<string, unknown> }
    expect(built.pool).toEqual({ min: 0, max: 1, idleTimeoutMillis: SESSION_IDLE_MS })
    expect(built.validateConnection).toBe(false)
    expect(built.beforeConnect).toBe(hook)
    expect(built.database).toBe('reports')
    expect(built.server).toBe('127.0.0.1')
    expect(built.port).toBe(54321)
    expect(built.options.encrypt).toBe(true)
  })
})

describe('certificates', () => {
  it('checks the server certificate unless a connection says otherwise', () => {
    expect(DEFAULT_SQLSERVER_OPTIONS.encrypt).toBe(true)
    expect(DEFAULT_SQLSERVER_OPTIONS.trustServerCertificate).toBe(false)
  })

  /** The shape mssql hands back for a certificate Node turned down. */
  const refused = (code: string, reason: string): Error =>
    Object.assign(new Error(`Failed to connect to db.example.com:1433 - ${reason}`), {
      code: 'ESOCKET',
      originalError: Object.assign(new Error(`Failed to connect - ${reason}`), {
        cause: Object.assign(new Error(reason), { code })
      })
    })

  it('says what to do about a certificate this computer does not trust', () => {
    const message = untrustedCertificate(refused('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'))
    expect(message).toMatch(/db\.example\.com:1433/)
    expect(message).toMatch(/self-signed certificate/)
    expect(message).toMatch(/Trust server certificate/)
  })

  it('knows a name the certificate does not cover, and one that has expired', () => {
    expect(
      untrustedCertificate(refused('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames"))
    ).toMatch(/Trust server certificate/)
    expect(untrustedCertificate(refused('CERT_HAS_EXPIRED', 'certificate has expired'))).toMatch(
      /certificate has expired/
    )
  })

  it('leaves every other failure alone', () => {
    expect(untrustedCertificate(new Error("Login failed for user 'sa'."))).toBeNull()
    expect(untrustedCertificate(refused('ECONNREFUSED', 'connect ECONNREFUSED'))).toBeNull()
    expect(untrustedCertificate('nothing like an error')).toBeNull()
  })
})

describe('describeConnection', () => {
  it('renders host, port and database', () => {
    expect(describeConnection(config())).toBe('db.example.com:1433/app')
  })

  it('renders a named instance instead of a port', () => {
    expect(
      describeConnection(
        config({ options: { ...DEFAULT_SQLSERVER_OPTIONS, instanceName: 'SQLEXPRESS' } })
      )
    ).toBe('db.example.com\\SQLEXPRESS/app')
  })
})

describe('driver type mapping', () => {
  const column = (type: string, extra: Record<string, unknown> = {}) => ({
    index: 0,
    name: 'c',
    type: { declaration: type },
    ...extra
  })

  it('reads the declaration', () => {
    expect(declarationOf(column('NVarChar'))).toBe('nvarchar')
    expect(declarationOf({ index: 0, name: 'c' })).toBe('unknown')
    expect(declarationOf({ index: 0, name: 'c', udt: { name: 'Geography' } })).toBe('geography')
  })

  it('renders variable-length types, halving the byte length for wide ones', () => {
    expect(renderDriverType(column('varchar', { length: 50 }))).toBe('varchar(50)')
    expect(renderDriverType(column('nvarchar', { length: 100 }))).toBe('nvarchar(50)')
    expect(renderDriverType(column('char', { length: 5 }))).toBe('char(5)')
    expect(renderDriverType(column('binary', { length: 4 }))).toBe('binary(4)')
  })

  it('renders MAX', () => {
    expect(renderDriverType(column('varchar', { length: 65535 }))).toBe('varchar(max)')
    expect(renderDriverType(column('nvarchar', { length: 65535 }))).toBe('nvarchar(max)')
  })

  it('never renders a zero length', () => {
    expect(renderDriverType(column('varchar', { length: 1 }))).toBe('varchar(1)')
    expect(renderDriverType(column('nvarchar', { length: 1 }))).toBe('nvarchar(1)')
  })

  it('renders precision, scale and simple types', () => {
    expect(renderDriverType(column('decimal', { precision: 18, scale: 4 }))).toBe('decimal(18, 4)')
    expect(renderDriverType(column('datetime2', { scale: 3 }))).toBe('datetime2(3)')
    expect(renderDriverType(column('time', { scale: 0 }))).toBe('time(0)')
    expect(renderDriverType(column('int'))).toBe('int')
    expect(renderDriverType(column('varchar'))).toBe('varchar')
  })

  it('maps declarations to a JS kind', () => {
    expect(jsKindOf('nvarchar')).toBe('string')
    expect(jsKindOf('uniqueidentifier')).toBe('string')
    expect(jsKindOf('xml')).toBe('string')
    expect(jsKindOf('int')).toBe('number')
    expect(jsKindOf('money')).toBe('number')
    expect(jsKindOf('bit')).toBe('boolean')
    expect(jsKindOf('datetimeoffset')).toBe('date')
    expect(jsKindOf('varbinary')).toBe('bytes')
    expect(jsKindOf('geography')).toBe('bytes')
    expect(jsKindOf('variant')).toBe('json')
    expect(jsKindOf('something-else')).toBe('unknown')
  })

  it('knows which types cannot be written back', () => {
    expect(isReadOnlyType('rowversion')).toBe(true)
    expect(isReadOnlyType('timestamp')).toBe(true)
    expect(isReadOnlyType('int')).toBe(false)
  })
})

describe('mapDriverColumns', () => {
  it('builds column metadata', () => {
    const [column] = mapDriverColumns([
      {
        index: 0,
        name: 'email',
        type: { declaration: 'nvarchar' },
        length: 510,
        nullable: false,
        identity: false,
        readOnly: false
      }
    ])
    expect(column).toEqual({
      name: 'email',
      index: 0,
      dataType: 'nvarchar(255)',
      jsKind: 'string',
      nullable: false,
      isIdentity: false,
      isReadOnly: false
    })
  })

  it('names an unnamed expression column', () => {
    expect(mapDriverColumns([{ index: 0, name: '' }])[0].name).toBe('(no name 1)')
  })

  it('marks rowversion read-only even when the driver does not', () => {
    const [column] = mapDriverColumns([
      { index: 0, name: 'v', type: { declaration: 'rowversion' }, readOnly: false }
    ])
    expect(column.isReadOnly).toBe(true)
  })
})

describe('serializeError', () => {
  it('extracts the SQL Server error fields', () => {
    const error = Object.assign(new Error('Invalid object name'), {
      code: 'EREQUEST',
      originalError: {
        message: 'original text',
        info: { number: 208, state: 1, class: 16, lineNumber: 3, procName: 'p', serverName: 's' }
      }
    })
    expect(serializeError(error)).toEqual({
      message: 'Invalid object name',
      code: 'EREQUEST',
      number: 208,
      state: 1,
      class: 16,
      lineNumber: 3,
      procName: 'p',
      serverName: 's',
      detail: 'original text'
    })
  })

  it('handles a plain error and a non-error', () => {
    expect(serializeError(new Error('boom')).message).toBe('boom')
    expect(serializeError('a string')).toEqual({ message: 'a string' })
  })
})
