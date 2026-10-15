/**
 * The connection export file.
 *
 * The one thing this format has to get right is what it leaves out. An export
 * is a plain file — it lands in a downloads folder, goes out as an attachment
 * and ends up in a backup — so the tests that matter here are the ones that
 * look through the whole serialised payload for anything that could open a
 * database, rather than checking field by field that the ones we remembered
 * to strip are gone.
 */
import { describe, expect, it } from 'vitest'
import {
  CONNECTION_EXPORT_KIND,
  buildExport,
  exportFileName,
  parseExportFile,
  planImport,
  toExportedConnection,
  toSaveInput
} from '../../src/shared/connectionTransfer'
import {
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG
} from '../../src/shared/types'
import type { SavedConnection } from '../../src/shared/types'

const PASSWORD = 'hunter2-the-real-one'
const PASSPHRASE = 'passphrase-of-the-key'
const AWS_SECRET = 'wJalrXUtnFEMI-EXAMPLEKEY'

/** A connection carrying every secret the app can hold for one. */
const loaded = (overrides: Partial<SavedConnection> = {}): SavedConnection =>
  ({
    id: 'c1',
    name: 'Production reporting',
    group: 'Production',
    engine: 'sqlserver',
    color: '#d64545',
    host: 'prod-sql.internal',
    port: 1433,
    database: 'Reporting',
    authType: 'sql',
    username: 'svc_report',
    domain: undefined,
    savePassword: true,
    options: { ...DEFAULT_SQLSERVER_OPTIONS },
    ssh: {
      ...DEFAULT_SSH_CONFIG,
      enabled: true,
      host: 'bastion.internal',
      username: 'deploy',
      authMode: 'password'
    },
    ssm: { ...DEFAULT_SSM_CONFIG },
    createdAt: '2024-02-01T09:00:00.000Z',
    updatedAt: '2024-05-01T09:00:00.000Z',
    lastUsedAt: '2024-06-01T09:00:00.000Z',
    hasSavedPassword: true,
    hasSavedSshPassword: true,
    hasSavedSshPassphrase: true,
    hasSavedAwsCredentials: true,
    ...overrides
  }) as SavedConnection

describe('what an export carries', () => {
  it('keeps what a connection is', () => {
    const exported = toExportedConnection(loaded())
    expect(exported).toMatchObject({
      name: 'Production reporting',
      group: 'Production',
      host: 'prod-sql.internal',
      port: 1433,
      database: 'Reporting',
      username: 'svc_report',
      createdAt: '2024-02-01T09:00:00.000Z'
    })
    expect(exported.ssh.host).toBe('bastion.internal')
  })

  it('says which secrets the other end will be asked for', () => {
    expect(toExportedConnection(loaded()).missingSecrets).toEqual([
      'password',
      'sshPassword',
      'sshPassphrase',
      'awsCredentials'
    ])
    const plain = loaded({
      hasSavedPassword: false,
      hasSavedSshPassword: false,
      hasSavedSshPassphrase: false,
      hasSavedAwsCredentials: false
    })
    expect(toExportedConnection(plain).missingSecrets).toEqual([])
  })
})

describe('what an export must never carry', () => {
  /**
   * A record as it would be if a secret got past the redaction upstream — the
   * exporter is handed one anyway, because "nothing upstream would do that" is
   * exactly the assumption worth testing.
   */
  const withSecretsAttached = loaded({
    password: PASSWORD,
    ssh: {
      ...DEFAULT_SSH_CONFIG,
      enabled: true,
      host: 'bastion.internal',
      username: 'deploy',
      authMode: 'privateKey',
      password: PASSWORD,
      passphrase: PASSPHRASE
    },
    ssm: {
      ...DEFAULT_SSM_CONFIG,
      enabled: true,
      credentials: `enc:${AWS_SECRET}`,
      credentialsText: `aws_secret_access_key=${AWS_SECRET}`,
      credentialSummary: {
        accessKeyId: 'ASIA****MPLE',
        region: 'eu-west-2',
        temporary: true,
        savedAt: '2024-06-01T09:00:00.000Z'
      }
    }
  } as Partial<SavedConnection>)

  const serialised = JSON.stringify(buildExport([withSecretsAttached]))

  it('has no password, passphrase or AWS key anywhere in the file', () => {
    for (const secret of [PASSWORD, PASSPHRASE, AWS_SECRET]) {
      expect(serialised).not.toContain(secret)
    }
  })

  it('drops the credential summary too, which describes keys it does not have', () => {
    expect(serialised).not.toContain('ASIA****MPLE')
    expect(serialised).not.toContain('credentialSummary')
  })

  it('names the fields it does carry rather than deleting the ones it does not', () => {
    // A new field on ConnectionConfig should arrive absent, so that letting it
    // travel is a decision someone makes rather than one they forget to make.
    const exported = toExportedConnection({
      ...withSecretsAttached,
      secretToken: 'invented-later'
    } as unknown as SavedConnection)
    expect(JSON.stringify(exported)).not.toContain('invented-later')
  })

  it('leaves the history of the machine it came from behind', () => {
    const exported = toExportedConnection(loaded())
    expect(exported).not.toHaveProperty('lastUsedAt')
    expect(exported).not.toHaveProperty('id')
  })
})

describe('reading a file back', () => {
  const file = () => JSON.stringify(buildExport([loaded(), loaded({ name: 'Local dev', group: '' })]))

  it('round-trips what it wrote', () => {
    const parsed = parseExportFile(file())
    expect(parsed.kind).toBe(CONNECTION_EXPORT_KIND)
    expect(parsed.connections.map((entry) => entry.name)).toEqual([
      'Production reporting',
      'Local dev'
    ])
    expect(parsed.connections[1].group).toBeUndefined()
  })

  // TableView was called Beekeeper Clone, and files exported under that name
  // are still lying around in download folders.
  it('still reads a file Beekeeper Clone wrote', () => {
    const old = JSON.stringify({
      kind: 'beekeeper-clone/connections',
      version: 1,
      exportedAt: '2026-09-16T12:31:00.000Z',
      connections: [{ name: 'Production reporting', host: 'prod-sql.internal' }]
    })
    expect(parseExportFile(old).connections.map((entry) => entry.name)).toEqual([
      'Production reporting'
    ])
  })

  it('turns down something that is not JSON', () => {
    expect(() => parseExportFile('nope')).toThrow(/not JSON/)
  })

  it('turns down JSON that is not one of ours', () => {
    expect(() => parseExportFile('{"some":"other file"}')).toThrow(/not a TableView/)
    expect(() => parseExportFile('[]')).toThrow(/does not hold a connection export/)
  })

  it('turns down a file from a version that knows more than this one', () => {
    const ahead = JSON.stringify({ kind: CONNECTION_EXPORT_KIND, version: 99, connections: [] })
    expect(() => parseExportFile(ahead)).toThrow(/newer version/)
  })

  it('names the row it could not read', () => {
    const broken = JSON.stringify({
      kind: CONNECTION_EXPORT_KIND,
      version: 1,
      connections: [{ name: 'Fine', host: 'db' }, { name: 'Nameless' }]
    })
    expect(() => parseExportFile(broken)).toThrow(/“Nameless” in that file has no server/)
  })

  it('falls back to the default port rather than refusing the file', () => {
    const odd = JSON.stringify({
      kind: CONNECTION_EXPORT_KIND,
      version: 1,
      connections: [{ name: 'Odd', host: 'db', port: 'not a port' }]
    })
    expect(parseExportFile(odd).connections[0].port).toBe(1433)
  })
})

describe('planning an import', () => {
  const file = () =>
    parseExportFile(
      JSON.stringify(
        buildExport([
          loaded({ name: 'Prod' }),
          loaded({ name: 'Staging' }),
          loaded({ name: 'Local' })
        ])
      )
    )

  it('adds the ones that are not here', () => {
    const plan = planImport(file(), [{ name: 'Staging' }])
    expect(plan.add.map((entry) => entry.name)).toEqual(['Prod', 'Local'])
    expect(plan.skipped).toEqual(['Staging'])
  })

  it('matches names regardless of case and stray spaces', () => {
    const plan = planImport(file(), [{ name: '  prod  ' }])
    expect(plan.skipped).toEqual(['Prod'])
  })

  it('is safe to run twice: the second time adds nothing', () => {
    const first = planImport(file(), [])
    const second = planImport(file(), first.add)
    expect(second.add).toEqual([])
    expect(second.skipped).toHaveLength(3)
  })

  it('does not import one name twice out of a file that repeats it', () => {
    const doubled = parseExportFile(
      JSON.stringify(buildExport([loaded({ name: 'Prod' }), loaded({ name: 'prod' })]))
    )
    const plan = planImport(doubled, [])
    expect(plan.add).toHaveLength(1)
    expect(plan.skipped).toEqual(['prod'])
  })
})

describe('turning one back into a connection', () => {
  it('carries the group, the colour and the day it was made', () => {
    const input = toSaveInput(toExportedConnection(loaded()))
    expect(input).toMatchObject({
      name: 'Production reporting',
      group: 'Production',
      color: '#d64545',
      createdAt: '2024-02-01T09:00:00.000Z',
      savePassword: true
    })
  })

  // The safety setting is the one a copy on another machine most needs.
  it('stays read-only on the machine it moves to', () => {
    const file = JSON.stringify(buildExport([loaded({ readOnly: true })]))
    expect(toSaveInput(parseExportFile(file).connections[0]).readOnly).toBe(true)
  })

  it('arrives writable from a file written before read-only existed', () => {
    const exported: Record<string, unknown> = { ...toExportedConnection(loaded()) }
    delete exported.readOnly
    const file = JSON.stringify({
      kind: CONNECTION_EXPORT_KIND,
      version: 1,
      exportedAt: '2024-06-01T09:00:00.000Z',
      connections: [exported]
    })
    expect(toSaveInput(parseExportFile(file).connections[0]).readOnly).toBe(false)
  })

  it('brings no password with it, however the flag reads', () => {
    const input = toSaveInput(toExportedConnection(loaded()))
    expect(input.password).toBeUndefined()
    expect(input.ssh?.password).toBeUndefined()
    expect(input.ssm?.credentials).toBeUndefined()
  })
})

describe('the file it is offered as', () => {
  it('is dated, so two exports do not overwrite each other', () => {
    expect(exportFileName(new Date('2026-09-16T12:31:00.000Z'))).toBe(
      'tableview-connections-2026-09-16.json'
    )
  })
})
