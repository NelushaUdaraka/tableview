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
import {
  parseTablePlusUrl,
  tablePlusStatus,
  tablePlusUrlFromClipboard,
  type TablePlusFormState,
  type TablePlusImport
} from '../../src/shared/tableplus'
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

describe('tablePlusStatus', () => {
  const SAME_NAME =
    'You already have a connection called “App DEV”. Saving adds this one beside it; that one stays as it is.'
  const READ_ONLY =
    'TablePlus had a safe mode on for this one, so it arrives read-only. Untick Read-only before saving if you do not want that.'
  const KEY_FILE = 'Choose the SSH key file on the Tunnel tab: TablePlus does not put it in the URL.'
  const NO_LOGIN =
    'No login came with this URL. If the connection signs in with Windows or Microsoft Entra ID, set that up by hand before saving.'

  /** The status straight after pasting this URL into an empty list. */
  const statusOf = (url: string, state: Partial<TablePlusFormState> = {}) => {
    const result: TablePlusImport = parseTablePlusUrl(url)
    return tablePlusStatus(result, {
      name: result.connection.name,
      savedNames: [],
      keyFileChosen: false,
      ...state
    })
  }

  it('sums up what came across', () => {
    expect(statusOf(WINDOWS_URL)).toEqual({
      summary: 'Filled in from TablePlus · password included · colour blue',
      warnings: []
    })
    expect(
      statusOf(
        'sqlserver+ssh://deploy:ssh%40pw@bastion.example.com:2222/appuser:db%2Fpw@10.0.0.5:1433/appdb'
      ).summary
    ).toBe('Filled in from TablePlus · password included · SSH tunnel')
    expect(statusOf('sqlserver://appuser@h/db').summary).toBe('Filled in from TablePlus')
  })

  it('warns about a name already saved, however it is spelt', () => {
    expect(statusOf(WINDOWS_URL, { savedNames: [' app dev '] }).warnings[0]).toBe(SAME_NAME)
    // Renamed in the form since the paste: nothing to warn about any more.
    expect(
      statusOf(WINDOWS_URL, { name: 'App DEV 2', savedNames: [' app dev '] }).warnings
    ).not.toContain(SAME_NAME)
  })

  it('says a safe mode arrived as read-only', () => {
    expect(statusOf('sqlserver://appuser@h/db?safeModeLevel=2').warnings).toContain(READ_ONLY)
  })

  it('asks for the key file until one is chosen', () => {
    const url =
      'sqlserver+ssh://deploy:keypass@bastion.example.com/appuser:pw@10.0.0.5/appdb?usePrivateKey=true'
    expect(statusOf(url).warnings).toContain(KEY_FILE)
    expect(statusOf(url, { keyFileChosen: true }).warnings).not.toContain(KEY_FILE)
  })

  it('says when no login came with the URL', () => {
    expect(statusOf('sqlserver://h/db').warnings).toContain(NO_LOGIN)
  })

  it('puts the warnings in one order', () => {
    expect(
      statusOf('sqlserver+ssh://deploy@b/h/db?name=App%20DEV&usePrivateKey=true&safeModeLevel=1', {
        savedNames: ['App DEV']
      }).warnings
    ).toEqual([SAME_NAME, READ_ONLY, KEY_FILE, NO_LOGIN])
  })
})
