import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppData } from '../../src/main/storage/appData'
import {
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG
} from '../../src/shared/types'
import { LocalKeyVault } from '../../src/main/storage/crypto'
import { JsonStore } from '../../src/main/storage/store'

let dir: string
let appData: AppData

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-appdata-'))
  appData = new AppData(dir, new LocalKeyVault(path.join(dir, 'secret.key')))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('JsonStore', () => {
  it('returns defaults when the file is missing', () => {
    const store = new JsonStore(path.join(dir, 'none.json'), () => ({ a: 1 }))
    expect(store.read()).toEqual({ a: 1 })
  })

  it('persists and reloads', () => {
    const file = path.join(dir, 'data.json')
    new JsonStore(file, () => ({ a: 0 })).write({ a: 42 })
    expect(new JsonStore(file, () => ({ a: 0 })).read()).toEqual({ a: 42 })
  })

  it('sets restrictive permissions on the file', () => {
    const file = path.join(dir, 'perm.json')
    new JsonStore(file, () => ({})).write({})
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    }
  })

  it('keeps a corrupt file aside instead of discarding it', () => {
    const file = path.join(dir, 'broken.json')
    fs.writeFileSync(file, '{ not json')
    expect(new JsonStore(file, () => ({ a: 1 })).read()).toEqual({ a: 1 })
    expect(fs.readdirSync(dir).some((name) => name.includes('corrupt'))).toBe(true)
  })

  it('applies an update function', () => {
    const store = new JsonStore<{ n: number }>(path.join(dir, 'u.json'), () => ({ n: 0 }))
    expect(store.update((current) => ({ n: current.n + 5 }))).toEqual({ n: 5 })
    expect(store.read()).toEqual({ n: 5 })
  })

  // Windows hands out EPERM when a scanner or an indexer has either file open
  // for the moment; the lock goes away on its own.
  it('retries a rename the filesystem refuses', () => {
    const file = path.join(dir, 'locked.json')
    const real = fs.renameSync
    const rename = vi.spyOn(fs, 'renameSync')
    rename
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      })
      .mockImplementationOnce((from, to) => real(from, to))

    new JsonStore(file, () => ({ a: 0 })).write({ a: 7 })
    rename.mockRestore()

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 7 })
  })

  it('writes in place when the rename never goes through', () => {
    const file = path.join(dir, 'stubborn.json')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })

    new JsonStore(file, () => ({ a: 0 })).write({ a: 9 })
    rename.mockRestore()

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 9 })
  })

  it('leaves no temp file behind when a write cannot be committed', () => {
    // A directory standing where the file should be: nothing can be renamed
    // onto it and nothing can be written over it either.
    const file = path.join(dir, 'in-the-way.json')
    fs.mkdirSync(file)

    expect(() => new JsonStore(file, () => ({ a: 0 })).write({ a: 1 })).toThrow()
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})

describe('connections', () => {
  it('starts empty', () => {
    expect(appData.listConnections()).toEqual([])
  })

  it('saves and lists a connection', () => {
    const saved = appData.saveConnection({ name: 'Prod', host: 'db.example.com', port: 1433 })
    expect(saved.id).toBeTruthy()
    expect(saved.name).toBe('Prod')
    expect(appData.listConnections()).toHaveLength(1)
  })

  /**
   * The colour is the accent the whole window takes while the connection is
   * open, so taking one back off has to be possible — and an omitted field
   * still has to mean "leave what is stored alone", which is how every other
   * caller saves a connection without touching it.
   */
  it('keeps, clears and tidies the connection colour', () => {
    const saved = appData.saveConnection({ name: 'Prod', color: '1971C2' })
    expect(saved.color).toBe('#1971c2')

    const untouched = appData.saveConnection({ id: saved.id, name: 'Prod' })
    expect(untouched.color).toBe('#1971c2')

    const cleared = appData.saveConnection({ id: saved.id, name: 'Prod', color: '' })
    expect(cleared.color).toBeUndefined()

    // Anything that is not a colour is not stored as one.
    const nonsense = appData.saveConnection({ id: saved.id, name: 'Prod', color: 'chartreuse' })
    expect(nonsense.color).toBeUndefined()
  })

  /**
   * Read-only is a safety setting, so an edit that does not mention it — a
   * move to another group, a fresh block of AWS credentials — leaves it where
   * it is, the same contract as the colour.
   */
  it('keeps a connection read-only until an edit says otherwise', () => {
    const saved = appData.saveConnection({ name: 'Prod', readOnly: true })
    expect(saved.readOnly).toBe(true)

    const moved = appData.saveConnection({ id: saved.id, name: 'Prod', group: 'Live' })
    expect(moved.readOnly).toBe(true)
    expect(appData.getConnectionWithSecrets(saved.id)?.readOnly).toBe(true)

    const unlocked = appData.saveConnection({ id: saved.id, name: 'Prod', readOnly: false })
    expect(unlocked.readOnly).toBe(false)
  })

  it('makes a new connection writable unless it is asked not to', () => {
    expect(appData.saveConnection({ name: 'Dev' }).readOnly).toBe(false)
  })

  it('never returns a password to the renderer', () => {
    appData.saveConnection({ name: 'Prod', username: 'sa', password: 'hunter2', savePassword: true })
    const listed = appData.listConnections()[0]
    expect(listed.password).toBeUndefined()
    expect(listed.hasSavedPassword).toBe(true)
    expect(JSON.stringify(listed)).not.toContain('hunter2')
  })

  it('stores the password encrypted on disk', () => {
    appData.saveConnection({ name: 'Prod', password: 'hunter2', savePassword: true })
    const raw = fs.readFileSync(path.join(dir, 'connections.json'), 'utf8')
    expect(raw).not.toContain('hunter2')
    expect(raw).toContain('aes1:')
  })

  it('decrypts the password for the main process', () => {
    const saved = appData.saveConnection({
      name: 'Prod',
      password: 'hunter2',
      savePassword: true
    })
    expect(appData.getConnectionWithSecrets(saved.id)?.password).toBe('hunter2')
  })

  it('does not persist a password when the user declined to save it', () => {
    const saved = appData.saveConnection({ name: 'Prod', password: 'hunter2', savePassword: false })
    expect(saved.hasSavedPassword).toBe(false)
    expect(appData.getConnectionWithSecrets(saved.id)?.password).toBeUndefined()
  })

  it('keeps the stored password when the field is omitted on edit', () => {
    const saved = appData.saveConnection({ name: 'Prod', password: 'hunter2', savePassword: true })
    appData.saveConnection({ id: saved.id, name: 'Prod renamed' })
    const reloaded = appData.getConnectionWithSecrets(saved.id)
    expect(reloaded?.name).toBe('Prod renamed')
    expect(reloaded?.password).toBe('hunter2')
  })

  it('clears the password when the field is explicitly empty', () => {
    const saved = appData.saveConnection({ name: 'Prod', password: 'hunter2', savePassword: true })
    appData.saveConnection({ id: saved.id, name: 'Prod', password: '' })
    expect(appData.getConnectionWithSecrets(saved.id)?.password).toBeUndefined()
  })

  it('drops the stored password when saving is turned off', () => {
    const saved = appData.saveConnection({ name: 'Prod', password: 'hunter2', savePassword: true })
    appData.saveConnection({ id: saved.id, name: 'Prod', savePassword: false })
    expect(appData.getConnectionWithSecrets(saved.id)?.password).toBeUndefined()
  })

  it('encrypts SSH secrets too', () => {
    const saved = appData.saveConnection({
      name: 'Tunnelled',
      ssh: {
        enabled: true,
        host: 'bastion',
        port: 22,
        username: 'deploy',
        authMode: 'password',
        password: 'ssh-secret',
        keepaliveIntervalMs: 10000
      }
    })
    const listed = appData.listConnections()[0]
    expect(listed.ssh.password).toBeUndefined()
    expect(listed.hasSavedSshPassword).toBe(true)

    const raw = fs.readFileSync(path.join(dir, 'connections.json'), 'utf8')
    expect(raw).not.toContain('ssh-secret')
    expect(appData.getConnectionWithSecrets(saved.id)?.ssh.password).toBe('ssh-secret')
  })

  it('stores the key passphrase for key auth', () => {
    const saved = appData.saveConnection({
      name: 'Keyed',
      ssh: {
        enabled: true,
        host: 'bastion',
        port: 22,
        username: 'deploy',
        authMode: 'privateKey',
        privateKeyPath: '/keys/id',
        passphrase: 'pp',
        keepaliveIntervalMs: 10000
      }
    })
    expect(appData.getConnectionWithSecrets(saved.id)?.ssh.passphrase).toBe('pp')
    expect(appData.listConnections()[0].hasSavedSshPassphrase).toBe(true)
  })

  it('round-trips an SSM tunnel configuration', () => {
    const saved = appData.saveConnection({
      name: 'Via bastion',
      host: 'db.internal.rds.amazonaws.com',
      ssm: {
        enabled: true,
        credentialSource: 'pasted',
        instanceId: 'i-0123456789abcdef0',
        mode: 'remote-host',
        profile: 'prod',
        region: 'eu-west-2',
        localPort: 0,
        startTimeoutMs: 30000
      }
    })

    // SSM settings hold no secrets, so they are safe to hand to the renderer.
    const listed = appData.listConnections()[0]
    expect(listed.ssm.enabled).toBe(true)
    expect(listed.ssm.instanceId).toBe('i-0123456789abcdef0')
    expect(listed.ssm.profile).toBe('prod')

    const full = appData.getConnectionWithSecrets(saved.id)!
    expect(full.ssm.mode).toBe('remote-host')
    expect(full.ssm.region).toBe('eu-west-2')
  })

  describe('AWS credentials stored with the connection', () => {
    const BLOCK = [
      'export AWS_ACCESS_KEY_ID="ASIAIOSFODNN7EXAMPLE"',
      'export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
      'export AWS_SESSION_TOKEN="IQoJb3JpZ2luX2VjEJr"',
      'export AWS_DEFAULT_REGION="eu-west-2"'
    ].join('\n')

    function saveWithCredentials(text?: string, id?: string) {
      return appData.saveConnection({
        id,
        name: 'Via bastion',
        host: 'db.internal',
        ssm: {
          ...DEFAULT_SSM_CONFIG,
          enabled: true,
          credentialSource: 'pasted',
          instanceId: 'i-0123456789abcdef0',
          credentialsText: text
        }
      })
    }

    it('encrypts the block and never writes it in the clear', () => {
      saveWithCredentials(BLOCK)
      const raw = fs.readFileSync(path.join(dir, 'connections.json'), 'utf8')
      expect(raw).not.toContain('wJalrXUtnFEMI')
      expect(raw).not.toContain('IQoJb3JpZ2luX2VjEJr')
      expect(raw).toContain('aes1:')
      // The transient input field must never be persisted.
      expect(raw).not.toContain('credentialsText')
    })

    it('gives the renderer a summary but never the secret', () => {
      saveWithCredentials(BLOCK)
      const listed = appData.listConnections()[0]

      expect(listed.hasSavedAwsCredentials).toBe(true)
      expect(listed.ssm.credentials).toBeUndefined()
      expect(listed.ssm.credentialsText).toBeUndefined()
      expect(listed.ssm.credentialSummary).toMatchObject({
        accessKeyId: 'ASIA************MPLE',
        region: 'eu-west-2',
        temporary: true
      })
      expect(JSON.stringify(listed)).not.toContain('wJalrXUtnFEMI')
    })

    it('decrypts the block for the main process', () => {
      const saved = saveWithCredentials(BLOCK)
      const full = appData.getConnectionWithSecrets(saved.id)!
      const credentials = JSON.parse(full.ssm.credentials!)
      expect(credentials.accessKeyId).toBe('ASIAIOSFODNN7EXAMPLE')
      expect(credentials.secretAccessKey).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
      expect(credentials.sessionToken).toBe('IQoJb3JpZ2luX2VjEJr')
      expect(credentials.region).toBe('eu-west-2')
    })

    it('keeps the stored block when the field is omitted on edit', () => {
      const saved = saveWithCredentials(BLOCK)
      appData.saveConnection({ id: saved.id, name: 'Renamed' })
      const full = appData.getConnectionWithSecrets(saved.id)!
      expect(JSON.parse(full.ssm.credentials!).accessKeyId).toBe('ASIAIOSFODNN7EXAMPLE')
      expect(full.name).toBe('Renamed')
    })

    it('forgets the block when the field is explicitly empty', () => {
      const saved = saveWithCredentials(BLOCK)
      saveWithCredentials('', saved.id)
      const full = appData.getConnectionWithSecrets(saved.id)!
      expect(full.ssm.credentials).toBeUndefined()
      expect(appData.listConnections()[0].hasSavedAwsCredentials).toBe(false)
      expect(appData.listConnections()[0].ssm.credentialSummary).toBeUndefined()
    })

    it('replaces one block with another', () => {
      const saved = saveWithCredentials(BLOCK)
      saveWithCredentials('AWS_ACCESS_KEY_ID=AKIAOTHERKEY12345678\nAWS_SECRET_ACCESS_KEY=other', saved.id)
      const full = appData.getConnectionWithSecrets(saved.id)!
      const credentials = JSON.parse(full.ssm.credentials!)
      expect(credentials.accessKeyId).toBe('AKIAOTHERKEY12345678')
      // A long-lived key has no session token; the old one must not linger.
      expect(credentials.sessionToken).toBeUndefined()
      expect(appData.listConnections()[0].ssm.credentialSummary?.temporary).toBe(false)
    })

    it('rejects an unreadable block rather than storing rubbish', () => {
      expect(() => saveWithCredentials('this is not a credentials block')).toThrow(/No AWS keys/)
    })

    it('keeps the credentials of different connections separate', () => {
      const first = saveWithCredentials(BLOCK)
      const second = appData.saveConnection({
        name: 'Other account',
        ssm: {
          ...DEFAULT_SSM_CONFIG,
          enabled: true,
          credentialSource: 'pasted',
          instanceId: 'i-abcdef0123456789a',
          credentialsText: 'AWS_ACCESS_KEY_ID=ASIASECONDACCOUNT01\nAWS_SECRET_ACCESS_KEY=second'
        }
      })

      expect(JSON.parse(appData.getConnectionWithSecrets(first.id)!.ssm.credentials!).accessKeyId).toBe(
        'ASIAIOSFODNN7EXAMPLE'
      )
      expect(JSON.parse(appData.getConnectionWithSecrets(second.id)!.ssm.credentials!).accessKeyId).toBe(
        'ASIASECONDACCOUNT01'
      )
    })

    it('carries the credentials into a duplicated connection', () => {
      const saved = saveWithCredentials(BLOCK)
      const copy = appData.duplicateConnection(saved.id)!
      expect(copy.hasSavedAwsCredentials).toBe(true)
      expect(JSON.parse(appData.getConnectionWithSecrets(copy.id)!.ssm.credentials!).accessKeyId).toBe(
        'ASIAIOSFODNN7EXAMPLE'
      )
    })
  })

  it('keeps SSH and SSM settings independent when switching between them', () => {
    const saved = appData.saveConnection({
      name: 'Switcher',
      ssh: { ...DEFAULT_SSH_CONFIG, enabled: true, host: 'bastion', username: 'deploy' },
      ssm: { ...DEFAULT_SSM_CONFIG, enabled: false, instanceId: 'i-0123456789abcdef0' }
    })
    // Turning SSM on and SSH off must not discard the SSH details.
    appData.saveConnection({
      id: saved.id,
      name: 'Switcher',
      ssh: { ...DEFAULT_SSH_CONFIG, enabled: false, host: 'bastion', username: 'deploy' },
      ssm: { ...DEFAULT_SSM_CONFIG, enabled: true, instanceId: 'i-0123456789abcdef0' }
    })

    const full = appData.getConnectionWithSecrets(saved.id)!
    expect(full.ssm.enabled).toBe(true)
    expect(full.ssh.enabled).toBe(false)
    expect(full.ssh.host).toBe('bastion')
  })

  it('defaults SSM to disabled for a connection saved without it', () => {
    const saved = appData.saveConnection({ name: 'Plain' })
    expect(appData.getConnectionWithSecrets(saved.id)!.ssm.enabled).toBe(false)
    expect(appData.listConnections()[0].ssm.mode).toBe('remote-host')
  })

  it('fills in defaults for options and ssh', () => {
    const saved = appData.saveConnection({ name: 'Minimal' })
    const full = appData.getConnectionWithSecrets(saved.id)!
    expect(full.host).toBe('localhost')
    expect(full.port).toBe(1433)
    expect(full.engine).toBe('sqlserver')
    expect(full.options.applicationName).toBeTruthy()
    expect(full.ssh.enabled).toBe(false)
  })

  it('merges partial option updates onto what is stored', () => {
    const saved = appData.saveConnection({ name: 'Opts', options: { encrypt: false } as never })
    appData.saveConnection({ id: saved.id, name: 'Opts', options: { poolMax: 9 } as never })
    const full = appData.getConnectionWithSecrets(saved.id)!
    expect(full.options.poolMax).toBe(9)
    expect(full.options.encrypt).toBe(false)
  })

  it('deletes a connection and reports whether it existed', () => {
    const saved = appData.saveConnection({ name: 'Temp' })
    expect(appData.deleteConnection(saved.id)).toBe(true)
    expect(appData.deleteConnection(saved.id)).toBe(false)
    expect(appData.listConnections()).toEqual([])
  })

  it('duplicates a connection with a new id and a fresh name', () => {
    const saved = appData.saveConnection({ name: 'Prod', password: 'p', savePassword: true })
    appData.markConnectionUsed(saved.id)
    const copy = appData.duplicateConnection(saved.id)!
    expect(copy.id).not.toBe(saved.id)
    expect(copy.name).toBe('Prod (copy)')
    expect(copy.lastUsedAt).toBeUndefined()
    // The secret follows the copy, still encrypted.
    expect(appData.getConnectionWithSecrets(copy.id)?.password).toBe('p')
  })

  it('gives every copy a name of its own', () => {
    const saved = appData.saveConnection({ name: 'Prod' })
    const first = appData.duplicateConnection(saved.id)!
    const second = appData.duplicateConnection(saved.id)!
    // Duplicating the copy is where "(copy) (copy)" would come from.
    const third = appData.duplicateConnection(first.id)!

    expect([first.name, second.name, third.name]).toEqual([
      'Prod (copy)',
      'Prod (copy 2)',
      'Prod (copy 3)'
    ])
  })

  it('files the copy next to what it was copied from', () => {
    const first = appData.saveConnection({ name: 'Alpha' })
    appData.saveConnection({ name: 'Beta' })
    appData.duplicateConnection(first.id)

    // listConnections is storage order; the screen sorts it for display.
    expect(appData.listConnections().map((entry) => entry.name)).toEqual([
      'Alpha',
      'Alpha (copy)',
      'Beta'
    ])
  })

  it('copies the tunnel settings rather than sharing them', () => {
    const saved = appData.saveConnection({
      name: 'Bastioned',
      ssh: { ...DEFAULT_SSH_CONFIG, enabled: true, host: 'bastion', username: 'deploy' },
      options: { ...DEFAULT_SQLSERVER_OPTIONS, poolMax: 7 }
    })
    const copy = appData.duplicateConnection(saved.id)!
    appData.saveConnection({
      id: copy.id,
      name: copy.name,
      ssh: { ...DEFAULT_SSH_CONFIG, enabled: true, host: 'other-bastion', username: 'deploy' }
    })

    expect(appData.getConnectionWithSecrets(saved.id)!.ssh.host).toBe('bastion')
    expect(appData.getConnectionWithSecrets(copy.id)!.ssh.host).toBe('other-bastion')
    expect(appData.getConnectionWithSecrets(copy.id)!.options.poolMax).toBe(7)
  })

  it('keeps a duplicated connection read-only', () => {
    const saved = appData.saveConnection({ name: 'Prod', readOnly: true })
    expect(appData.duplicateConnection(saved.id)!.readOnly).toBe(true)
  })

  it('returns null when duplicating something that is not there', () => {
    expect(appData.duplicateConnection('nope')).toBeNull()
    expect(appData.getConnectionWithSecrets('nope')).toBeNull()
  })

  it('records when a connection was last used', () => {
    const saved = appData.saveConnection({ name: 'Prod' })
    expect(appData.listConnections()[0].lastUsedAt).toBeUndefined()
    appData.markConnectionUsed(saved.id)
    expect(appData.listConnections()[0].lastUsedAt).toBeTruthy()
  })

  it('survives a vault that cannot decrypt, rather than throwing', () => {
    const saved = appData.saveConnection({ name: 'Prod', password: 'hunter2', savePassword: true })
    // Simulate a lost key file.
    fs.rmSync(path.join(dir, 'secret.key'))
    const reopened = new AppData(dir, new LocalKeyVault(path.join(dir, 'secret.key')))
    expect(reopened.getConnectionWithSecrets(saved.id)?.password).toBeUndefined()
  })
})

// SQL Server lists every session under the application name its client gave,
// so a connection saved before the rename would still turn up there as
// Beekeeper Clone. Only the old default moves; a name someone chose stays.
describe('the name each connection gives SQL Server', () => {
  /** One saved connection, written the way Beekeeper Clone wrote it. */
  function storedByBeekeeperClone(applicationName: string): void {
    fs.writeFileSync(
      path.join(dir, 'connections.json'),
      JSON.stringify({
        version: 1,
        connections: [
          {
            id: 'c1',
            name: 'Production',
            engine: 'sqlserver',
            host: 'prod-sql.internal',
            port: 1433,
            authType: 'sql',
            username: 'reporting',
            savePassword: false,
            readOnly: false,
            options: { ...DEFAULT_SQLSERVER_OPTIONS, applicationName },
            ssh: { ...DEFAULT_SSH_CONFIG },
            ssm: { ...DEFAULT_SSM_CONFIG },
            createdAt: '2026-09-01T09:00:00.000Z',
            updatedAt: '2026-09-01T09:00:00.000Z'
          }
        ]
      })
    )
  }

  const reopen = (): AppData => new AppData(dir, new LocalKeyVault(path.join(dir, 'secret.key')))

  it("moves a saved connection off Beekeeper Clone's default name", () => {
    storedByBeekeeperClone('Beekeeper Clone')
    const reopened = reopen()
    expect(reopened.listConnections()[0].options.applicationName).toBe('TableView')
    expect(reopened.getConnectionWithSecrets('c1')?.options.applicationName).toBe('TableView')
  })

  it('keeps a name someone typed in', () => {
    storedByBeekeeperClone('Nightly ETL')
    expect(reopen().listConnections()[0].options.applicationName).toBe('Nightly ETL')
  })

  it('brings a Beekeeper Clone export in on the TableView name', () => {
    appData.importConnections(
      JSON.stringify({
        kind: 'beekeeper-clone/connections',
        version: 1,
        exportedAt: '2026-09-16T12:31:00.000Z',
        connections: [
          {
            name: 'Production',
            host: 'prod-sql.internal',
            port: 1433,
            authType: 'sql',
            savePassword: false,
            options: { ...DEFAULT_SQLSERVER_OPTIONS, applicationName: 'Beekeeper Clone' },
            ssh: { ...DEFAULT_SSH_CONFIG },
            ssm: { ...DEFAULT_SSM_CONFIG },
            missingSecrets: []
          }
        ]
      })
    )
    expect(appData.listConnections()[0].options.applicationName).toBe('TableView')
  })
})

describe('query history', () => {
  const entry = (sql: string, success = true) => ({
    connectionId: 'c1',
    connectionName: 'Prod',
    sql,
    runAt: new Date().toISOString(),
    durationMs: 5,
    rowCount: 1,
    success
  })

  it('records newest first', () => {
    appData.addHistory(entry('SELECT 1'))
    appData.addHistory(entry('SELECT 2'))
    expect(appData.listHistory().map((e) => e.sql)).toEqual(['SELECT 2', 'SELECT 1'])
  })

  it('assigns an id', () => {
    expect(appData.addHistory(entry('SELECT 1')).id).toBeTruthy()
  })

  it('searches case-insensitively', () => {
    appData.addHistory(entry('SELECT * FROM customers'))
    appData.addHistory(entry('SELECT * FROM orders'))
    expect(appData.listHistory('CUSTOMERS')).toHaveLength(1)
    expect(appData.listHistory('from')).toHaveLength(2)
  })

  it('honours the limit', () => {
    for (let i = 0; i < 20; i += 1) appData.addHistory(entry(`SELECT ${i}`))
    expect(appData.listHistory(undefined, 5)).toHaveLength(5)
  })

  it('clears', () => {
    appData.addHistory(entry('SELECT 1'))
    appData.clearHistory()
    expect(appData.listHistory()).toEqual([])
  })

  it('keeps failures with their message', () => {
    appData.addHistory({ ...entry('SELECT bad', false), errorMessage: 'Invalid object name' })
    expect(appData.listHistory()[0].errorMessage).toBe('Invalid object name')
  })
})

describe('saved queries', () => {
  it('creates, updates and sorts by name', () => {
    appData.saveQuery({ name: 'Zebra', sql: 'SELECT 1' })
    const alpha = appData.saveQuery({ name: 'Alpha', sql: 'SELECT 2' })
    expect(appData.listSavedQueries().map((q) => q.name)).toEqual(['Alpha', 'Zebra'])

    const updated = appData.saveQuery({ id: alpha.id, name: 'Alpha', sql: 'SELECT 3' })
    expect(updated.id).toBe(alpha.id)
    expect(updated.createdAt).toBe(alpha.createdAt)
    expect(appData.listSavedQueries()).toHaveLength(2)
    expect(appData.listSavedQueries()[0].sql).toBe('SELECT 3')
  })

  it('deletes and reports whether it existed', () => {
    const saved = appData.saveQuery({ name: 'Q', sql: 'SELECT 1' })
    expect(appData.deleteSavedQuery(saved.id)).toBe(true)
    expect(appData.deleteSavedQuery(saved.id)).toBe(false)
  })
})

describe('moving connections between machines', () => {
  const PASSWORD = 'hunter2-the-real-one'
  const SSH_PASSPHRASE = 'passphrase-of-the-key'

  /** A connection with a secret of every kind the vault holds. */
  function seed(): void {
    appData.saveConnection({
      name: 'Production reporting',
      group: 'Production',
      host: 'prod-sql.internal',
      port: 1433,
      database: 'Reporting',
      username: 'svc_report',
      password: PASSWORD,
      savePassword: true,
      color: '#d64545',
      ssh: {
        ...DEFAULT_SSH_CONFIG,
        enabled: true,
        host: 'bastion.internal',
        port: 22,
        username: 'deploy',
        authMode: 'privateKey',
        privateKeyPath: '~/.ssh/id_ed25519',
        passphrase: SSH_PASSPHRASE
      }
    })
    appData.saveConnection({ name: 'Local dev', host: 'localhost', port: 1433, username: 'sa' })
  }

  it('writes out what a connection is', () => {
    seed()
    const file = appData.exportConnections()

    expect(file.connections.map((entry) => entry.name)).toEqual([
      'Production reporting',
      'Local dev'
    ])
    expect(file.connections[0]).toMatchObject({
      group: 'Production',
      host: 'prod-sql.internal',
      database: 'Reporting',
      username: 'svc_report',
      color: '#d64545'
    })
    expect(file.connections[0].ssh.privateKeyPath).toBe('~/.ssh/id_ed25519')
  })

  it('writes out no secret of any kind', () => {
    seed()
    // Through the real vault: whatever is on disk is encrypted, and what comes
    // out here must not be the plaintext or the ciphertext of it.
    const stored = fs.readFileSync(path.join(dir, 'connections.json'), 'utf8')
    const serialised = JSON.stringify(appData.exportConnections())

    for (const secret of [PASSWORD, SSH_PASSPHRASE]) {
      expect(stored).not.toContain(secret)
      expect(serialised).not.toContain(secret)
    }
    expect(serialised).not.toContain('enc:')
  })

  it('says which connections will be asked for a password at the other end', () => {
    seed()
    const [reporting, local] = appData.exportConnections().connections
    expect(reporting.missingSecrets).toEqual(['password', 'sshPassphrase'])
    expect(local.missingSecrets).toEqual([])
  })

  it('imports into an empty app, group and all', () => {
    seed()
    const file = JSON.stringify(appData.exportConnections())

    const elsewhere = new AppData(
      fs.mkdtempSync(path.join(os.tmpdir(), 'bk-import-')),
      new LocalKeyVault(path.join(dir, 'other.key'))
    )
    const summary = elsewhere.importConnections(file)

    expect(summary.added).toEqual(['Production reporting', 'Local dev'])
    expect(summary.skipped).toEqual([])
    expect(summary.needSecrets).toEqual(['Production reporting'])

    const imported = elsewhere.listConnections()
    expect(imported.map((entry) => entry.group)).toEqual(['Production', undefined])
    expect(imported[0].ssh.host).toBe('bastion.internal')
    // The setting travels; the secret does not, so it will be asked for.
    expect(imported[0].savePassword).toBe(true)
    expect(imported[0].hasSavedPassword).toBe(false)
    expect(imported[0].hasSavedSshPassphrase).toBe(false)
  })

  it('keeps the day each connection was made', () => {
    seed()
    const before = appData.listConnections()[0].createdAt
    const elsewhere = new AppData(
      fs.mkdtempSync(path.join(os.tmpdir(), 'bk-import-')),
      new LocalKeyVault(path.join(dir, 'other.key'))
    )
    elsewhere.importConnections(JSON.stringify(appData.exportConnections()))
    expect(elsewhere.listConnections()[0].createdAt).toBe(before)
  })

  it('leaves a name that is already here alone', () => {
    seed()
    const file = JSON.stringify(appData.exportConnections())

    // Importing a machine's own export back into it: nothing new, nothing lost.
    const summary = appData.importConnections(file)
    expect(summary.added).toEqual([])
    expect(summary.skipped).toEqual(['Production reporting', 'Local dev'])
    expect(appData.listConnections()).toHaveLength(2)
    // And the secrets the file never carried are still here.
    expect(appData.listConnections()[0].hasSavedPassword).toBe(true)
  })

  it('refuses a file that is not an export, without touching the list', () => {
    seed()
    expect(() => appData.importConnections('{"kind":"something else"}')).toThrow(
      /not a TableView/
    )
    expect(appData.listConnections()).toHaveLength(2)
  })
})

describe('settings', () => {
  it('returns defaults', () => {
    expect(appData.getSettings().theme).toBe('dark')
  })

  it('merges a partial update and persists it', () => {
    expect(appData.updateSettings({ fontSize: 16 }).fontSize).toBe(16)
    expect(appData.getSettings().theme).toBe('dark')
    expect(new AppData(dir, new LocalKeyVault(path.join(dir, 'secret.key'))).getSettings().fontSize).toBe(16)
  })

  it('backfills a setting added after the file was written', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'light' }))
    const reopened = new AppData(dir, new LocalKeyVault(path.join(dir, 'secret.key')))
    expect(reopened.getSettings().theme).toBe('light')
    expect(reopened.getSettings().pageSize).toBeGreaterThan(0)
  })
})
