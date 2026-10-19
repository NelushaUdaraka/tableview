/**
 * Bringing a connection over from TablePlus.
 *
 * TablePlus hands a connection out as a URL (right-click → Copy as URL), so
 * what has to hold is that everything it carries lands in the right field —
 * the password above all, which is percent-encoded and full of the characters
 * a URL treats specially — and that anything which is not a SQL Server URL
 * from TablePlus is turned down before it fills in anything.
 */
import { describe, expect, it } from 'vitest'
import { parseTablePlusUrl, tablePlusUrlFromClipboard } from '../../src/shared/tableplus'
import { DEFAULT_SSH_CONFIG } from '../../src/shared/types'

/**
 * What TablePlus for Windows copied for a real connection, with every name and
 * secret replaced. The password keeps the original's mix of characters.
 */
const WINDOWS_URL =
  'microsoftsqlserver://appuser:Fake%7Bpw%27%7Cx%3B%29y~%60.z%3E9@127.0.0.1/appdb?statusColor=005392&env=development&name=App%20DEV&tLSMode=0&usePrivateKey=false&safeModeLevel=0&advancedSafeModeLevel=0&driverVersion=0&showSystemSchemas=0&driverVersion=0&lazyload=False'

const EMPTY =
  'The clipboard is empty. In TablePlus, right-click the connection and choose Copy as URL.'
const NOT_TABLEPLUS =
  'The clipboard does not hold a TablePlus URL. In TablePlus, right-click the connection and choose Copy as URL, then paste again.'

describe('parseTablePlusUrl', () => {
  it('fills in everything the Windows URL carries', () => {
    expect(parseTablePlusUrl(WINDOWS_URL)).toEqual({
      connection: {
        name: 'App DEV',
        host: '127.0.0.1',
        port: 1433,
        database: 'appdb',
        username: 'appuser',
        password: "Fake{pw'|x;)y~`.z>9",
        color: '#1971c2',
        group: 'Development',
        readOnly: false,
        ssh: { ...DEFAULT_SSH_CONFIG }
      },
      colourLabel: 'Blue',
      keyFileNeeded: false
    })
  })

  it('takes the sqlserver scheme too, in any case, with whitespace round it', () => {
    expect(
      parseTablePlusUrl('  \nSQLServer://sa:pw@db.example.com:14330/sales?name=Sales\n').connection
    ).toMatchObject({
      name: 'Sales',
      host: 'db.example.com',
      port: 14330,
      database: 'sales',
      username: 'sa',
      password: 'pw'
    })
  })

  it('falls back when TablePlus left things out', () => {
    const result = parseTablePlusUrl('sqlserver://db.example.com')
    expect(result.connection).toMatchObject({
      name: 'db.example.com',
      port: 1433,
      database: '',
      username: '',
      password: '',
      color: '',
      group: '',
      readOnly: false
    })
    expect(result.colourLabel).toBeNull()
    expect(parseTablePlusUrl('sqlserver://h?statusColor=nothex').connection.color).toBe('')
  })

  it('decodes the login without turning + into a space', () => {
    expect(
      parseTablePlusUrl('sqlserver://us%40er:p%40ss%3Aw%2Fo%3Fr%23d%25+%20x@h/db').connection
    ).toMatchObject({ username: 'us@er', password: 'p@ss:w/o?r#d%+ x' })
  })

  it('keeps a % that is not an escape instead of failing', () => {
    expect(parseTablePlusUrl('sqlserver://u:ab%zz@h/db').connection.password).toBe('ab%zz')
  })

  it('reads a space in the name written either way', () => {
    expect(parseTablePlusUrl('sqlserver://h/db?name=App%20DEV').connection.name).toBe('App DEV')
    expect(parseTablePlusUrl('sqlserver://h/db?name=App+DEV').connection.name).toBe('App DEV')
  })

  it('files the tag as a group', () => {
    const group = (env: string): string =>
      parseTablePlusUrl(`sqlserver://h/db?env=${env}`).connection.group
    expect(group('production')).toBe('Production')
    expect(group('staging')).toBe('Staging')
    expect(group('client%20work')).toBe('Client work')
    expect(group('')).toBe('')
  })

  it('arrives read-only for any safe mode but Silent', () => {
    const readOnly = (query: string): boolean =>
      parseTablePlusUrl(`sqlserver://h/db${query}`).connection.readOnly
    expect(readOnly('?safeModeLevel=0&advancedSafeModeLevel=0')).toBe(false)
    expect(readOnly('?safeModeLevel=1&advancedSafeModeLevel=0')).toBe(true)
    expect(readOnly('?safeModeLevel=1&advancedSafeModeLevel=1')).toBe(true)
    expect(readOnly('?safeModeLevel=2&advancedSafeModeLevel=0')).toBe(true)
    expect(readOnly('?safeModeLevel=2&advancedSafeModeLevel=1')).toBe(true)
    expect(readOnly('')).toBe(false)
  })

  it('brings an SSH tunnel with a password', () => {
    const result = parseTablePlusUrl(
      'sqlserver+ssh://deploy:ssh%40pw@bastion.example.com:2222/appuser:db%2Fpw@10.0.0.5:1433/appdb?name=Via%20SSH'
    )
    expect(result.connection.ssh).toEqual({
      ...DEFAULT_SSH_CONFIG,
      enabled: true,
      host: 'bastion.example.com',
      port: 2222,
      username: 'deploy',
      authMode: 'password',
      password: 'ssh@pw'
    })
    expect(result.connection).toMatchObject({
      name: 'Via SSH',
      host: '10.0.0.5',
      port: 1433,
      username: 'appuser',
      password: 'db/pw',
      database: 'appdb'
    })
    expect(result.keyFileNeeded).toBe(false)
  })

  it('asks for the key file a key tunnel needs, and takes the password as its passphrase', () => {
    const result = parseTablePlusUrl(
      'sqlserver+ssh://deploy:keypass@bastion.example.com/appuser:pw@10.0.0.5/appdb?usePrivateKey=true'
    )
    expect(result.connection.ssh).toEqual({
      ...DEFAULT_SSH_CONFIG,
      enabled: true,
      host: 'bastion.example.com',
      port: 22,
      username: 'deploy',
      authMode: 'privateKey',
      privateKeyPath: '',
      passphrase: 'keypass'
    })
    expect(result.keyFileNeeded).toBe(true)
  })

  it('uses the SSH agent with neither a key nor a password', () => {
    const result = parseTablePlusUrl(
      'sqlserver+ssh://deploy@bastion.example.com/appuser:pw@10.0.0.5/appdb'
    )
    expect(result.connection.ssh).toMatchObject({ enabled: true, authMode: 'agent' })
    expect(result.keyFileNeeded).toBe(false)
  })

  it('turns another database down by name', () => {
    expect(() => parseTablePlusUrl('postgres://u:pw@h/db')).toThrow(
      new Error('That is a PostgreSQL connection. TableView only connects to SQL Server.')
    )
    expect(() => parseTablePlusUrl('mysql+ssh://a@b/c:d@e/f')).toThrow(
      new Error('That is a MySQL connection. TableView only connects to SQL Server.')
    )
    expect(() => parseTablePlusUrl('mongodb://h')).toThrow(
      new Error('That is a MongoDB connection. TableView only connects to SQL Server.')
    )
  })

  it('turns down anything that is not a TablePlus URL', () => {
    for (const text of [
      'hunter2',
      'https://tableplus.com',
      'sqlserver:/one-slash',
      'Server=db;Database=x;'
    ]) {
      expect(() => parseTablePlusUrl(text), text).toThrow(/does not hold a TablePlus URL/)
    }
  })
})

describe('tablePlusUrlFromClipboard', () => {
  it('hands over the URL, trimmed', () => {
    expect(tablePlusUrlFromClipboard(` ${WINDOWS_URL}\n`)).toBe(WINDOWS_URL)
  })

  it('says the clipboard is empty', () => {
    expect(() => tablePlusUrlFromClipboard('  \n ')).toThrow(new Error(EMPTY))
  })

  // Whatever else is on it — a password, another database's URL — stays put.
  it('keeps everything else back', () => {
    expect(() => tablePlusUrlFromClipboard('hunter2')).toThrow(new Error(NOT_TABLEPLUS))
    expect(() => tablePlusUrlFromClipboard('postgres://u:pw@h/db')).toThrow(/PostgreSQL/)
  })
})
