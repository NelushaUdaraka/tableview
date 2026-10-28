import { describe, expect, it } from 'vitest'
import {
  EXPORT_EXTENSIONS,
  escapeDelimited,
  exportRows,
  rowToObject,
  sqlLiteral,
  toDelimited,
  toJson,
  toJsonLines,
  toMarkdown,
  toSqlInserts
} from '../../src/shared/export'
import type { CellValue, ColumnMeta } from '../../src/shared/types'

function meta(name: string, jsKind: ColumnMeta['jsKind'] = 'string', index = 0): ColumnMeta {
  return {
    name,
    index,
    dataType: jsKind === 'number' ? 'int' : 'nvarchar(50)',
    jsKind,
    nullable: true,
    isIdentity: false,
    isReadOnly: false
  }
}

const columns = [meta('id', 'number', 0), meta('name', 'string', 1)]
const rows: CellValue[][] = [
  [1, 'Ada'],
  [2, null],
  [3, 'O\'Brien, "Q"']
]

describe('escapeDelimited', () => {
  it('leaves plain values alone', () => {
    expect(escapeDelimited('plain', ',')).toBe('plain')
  })

  it('quotes values containing the delimiter, quotes or newlines', () => {
    expect(escapeDelimited('a,b', ',')).toBe('"a,b"')
    expect(escapeDelimited('say "hi"', ',')).toBe('"say ""hi"""')
    expect(escapeDelimited('line1\nline2', ',')).toBe('"line1\nline2"')
    expect(escapeDelimited('cr\rhere', ',')).toBe('"cr\rhere"')
  })

  it('respects a tab delimiter', () => {
    expect(escapeDelimited('a,b', '\t')).toBe('a,b')
    expect(escapeDelimited('a\tb', '\t')).toBe('"a\tb"')
  })
})

describe('toDelimited', () => {
  it('writes a header and rows', () => {
    const csv = toDelimited(columns, rows, { format: 'csv', includeHeader: true })
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe('id,name')
    expect(lines[1]).toBe('1,Ada')
    expect(lines[2]).toBe('2,')
    expect(lines[3]).toBe('3,"O\'Brien, ""Q"""')
  })

  it('can omit the header', () => {
    const csv = toDelimited(columns, rows, { format: 'csv', includeHeader: false })
    expect(csv.split('\n')[0]).toBe('1,Ada')
  })

  it('honours a custom NULL representation', () => {
    const csv = toDelimited(columns, rows, { format: 'csv', includeHeader: false, nullString: 'NULL' })
    expect(csv.split('\n')[1]).toBe('2,NULL')
  })

  it('honours CRLF line endings', () => {
    const csv = toDelimited(columns, [[1, 'a']], { format: 'csv', lineEnding: '\r\n' })
    expect(csv).toContain('\r\n')
  })

  it('produces an empty string for no rows and no header', () => {
    expect(toDelimited(columns, [], { format: 'csv', includeHeader: false })).toBe('')
  })

  // Text from the database opened in a spreadsheet runs as a formula when it
  // starts with one of these, and a formula can reach outside the sheet.
  it('keeps text from running as a spreadsheet formula when asked', () => {
    const text = ['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\tTAB', '\rCR', 'plain', '-5', '-1.5e3']
    const csv = toDelimited(
      [meta('v', 'string', 0)],
      text.map((value) => [value]),
      { format: 'csv', includeHeader: false, escapeFormulas: true }
    )
    expect(csv.split('\n').slice(0, -1)).toEqual([
      `"'=HYPERLINK(""http://x"",""y"")"`,
      "'+1+1",
      "'-2+3",
      "'@SUM(A1)",
      "'\tTAB",
      `"'\rCR"`,
      'plain',
      // A number is not a formula, and stays as it is.
      '-5',
      '-1.5e3'
    ])
  })

  it('leaves numbers, and text it was not asked about, as they are', () => {
    expect(toDelimited(columns, [[-1, '=1+1']], { format: 'csv', includeHeader: false })).toBe('-1,=1+1\n')
    expect(
      toDelimited(columns, [[-1, 'x']], { format: 'csv', includeHeader: false, escapeFormulas: true })
    ).toBe('-1,x\n')
  })
})

describe('rowToObject', () => {
  it('maps values onto column names', () => {
    expect(rowToObject(columns, [1, 'Ada'])).toEqual({ id: 1, name: 'Ada' })
  })

  it('disambiguates repeated column names', () => {
    const dupes = [meta('x', 'string', 0), meta('x', 'string', 1)]
    expect(rowToObject(dupes, ['a', 'b'])).toEqual({ x: 'a', x_2: 'b' })
  })

  it('names unnamed columns', () => {
    expect(rowToObject([meta('', 'string', 0)], ['v'])).toEqual({ column_1: 'v' })
  })

  it('unwraps tagged values', () => {
    const cols = [meta('d', 'date'), meta('b', 'bytes', 1)]
    const object = rowToObject(cols, [
      { t: 'date', v: '2024-01-01T00:00:00.000Z' },
      { t: 'bytes', v: 'ff', n: 1 }
    ])
    expect(object.d).toBe('2024-01-01T00:00:00.000Z')
    expect(object.b).toBe('0xff')
  })

  it('parses embedded JSON when it is valid', () => {
    expect(rowToObject([meta('j')], [{ t: 'json', v: '{"a":1}' }]).j).toEqual({ a: 1 })
    expect(rowToObject([meta('j')], [{ t: 'json', v: 'not json' }]).j).toBe('not json')
  })
})

describe('toJson / toJsonLines', () => {
  it('emits an array of objects', () => {
    expect(JSON.parse(toJson(columns, rows))).toEqual([
      { id: 1, name: 'Ada' },
      { id: 2, name: null },
      { id: 3, name: 'O\'Brien, "Q"' }
    ])
  })

  it('emits one object per line', () => {
    const lines = toJsonLines(columns, rows).trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toEqual({ id: 1, name: 'Ada' })
  })

  it('emits nothing for no rows', () => {
    expect(toJsonLines(columns, [])).toBe('')
  })
})

describe('sqlLiteral', () => {
  it('renders NULL', () => {
    expect(sqlLiteral(null)).toBe('NULL')
  })

  it('renders numbers bare and strings quoted', () => {
    expect(sqlLiteral(42)).toBe('42')
    expect(sqlLiteral('text')).toBe("N'text'")
    expect(sqlLiteral("it's")).toBe("N'it''s'")
  })

  it('renders booleans as bits', () => {
    expect(sqlLiteral(true)).toBe('1')
    expect(sqlLiteral(false)).toBe('0')
  })

  it('drops the trailing Z, which SQL Server datetime literals reject', () => {
    expect(sqlLiteral({ t: 'date', v: '2024-06-01T12:34:56.000Z' })).toBe(
      "'2024-06-01T12:34:56.000'"
    )
  })

  it('renders binary as a hex literal', () => {
    expect(sqlLiteral({ t: 'bytes', v: 'deadbeef', n: 4 })).toBe('0xdeadbeef')
    expect(sqlLiteral({ t: 'bytes', v: '', n: 0 })).toBe('0x')
  })

  it('leaves a numeric-column string unquoted, since bigint arrives as text', () => {
    const numeric = meta('n', 'number')
    expect(sqlLiteral('9007199254740993', numeric)).toBe('9007199254740993')
    expect(sqlLiteral('-1.5e3', numeric)).toBe('-1.5e3')
    // Not numeric text: quote it so invalid data does not become invalid SQL.
    expect(sqlLiteral('abc', numeric)).toBe("N'abc'")
    // Without column context the safe choice is a quoted literal.
    expect(sqlLiteral('9007199254740993')).toBe("N'9007199254740993'")
  })
})

describe('toSqlInserts', () => {
  it('writes one INSERT per row', () => {
    const sql = toSqlInserts(columns, rows, 'dbo.customers')
    const lines = sql.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe("INSERT INTO [dbo].[customers] ([id], [name]) VALUES (1, N'Ada');")
    expect(lines[1]).toContain('VALUES (2, NULL)')
  })

  it('handles an unqualified name', () => {
    expect(toSqlInserts(columns, [[1, 'a']], 'customers')).toContain('INSERT INTO [customers]')
  })

  it('strips brackets the caller already added', () => {
    expect(toSqlInserts(columns, [[1, 'a']], '[dbo].[t]')).toContain('INSERT INTO [dbo].[t]')
  })

  it('says so when there is nothing to write', () => {
    expect(toSqlInserts(columns, [])).toContain('no rows')
  })
})

describe('toMarkdown', () => {
  it('writes a pipe table and escapes pipes and newlines', () => {
    const md = toMarkdown(columns, [[1, 'a|b'], [2, 'x\ny']])
    const lines = md.trimEnd().split('\n')
    expect(lines[0]).toBe('| id | name |')
    expect(lines[1]).toBe('| --- | --- |')
    expect(lines[2]).toBe('| 1 | a\\|b |')
    expect(lines[3]).toBe('| 2 | x<br>y |')
  })

  it('shows NULL explicitly', () => {
    expect(toMarkdown(columns, [[1, null]])).toContain('| 1 | NULL |')
  })
})

describe('exportRows', () => {
  it('dispatches on format', () => {
    expect(exportRows(columns, rows, { format: 'csv', includeHeader: true })).toContain('id,name')
    expect(exportRows(columns, rows, { format: 'tsv', includeHeader: true })).toContain('id\tname')
    expect(exportRows(columns, rows, { format: 'json', includeHeader: true })).toContain('"id"')
    expect(exportRows(columns, rows, { format: 'jsonl', includeHeader: true })).toContain('{"id"')
    expect(exportRows(columns, rows, { format: 'sql', includeHeader: true })).toContain('INSERT')
    expect(exportRows(columns, rows, { format: 'markdown', includeHeader: true })).toContain('| id |')
  })

  it('rejects an unknown format', () => {
    expect(() =>
      // @ts-expect-error deliberately invalid
      exportRows(columns, rows, { format: 'xlsx', includeHeader: true })
    ).toThrow(/Unsupported export format/)
  })

  it('has an extension for every format', () => {
    expect(Object.keys(EXPORT_EXTENSIONS).sort()).toEqual(
      ['csv', 'json', 'jsonl', 'markdown', 'sql', 'tsv'].sort()
    )
  })
})
