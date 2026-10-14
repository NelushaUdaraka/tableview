import { describe, expect, it } from 'vitest'
import {
  asCreateOrAlter,
  returnsRows,
  splitBatches,
  splitStatements,
  statementAt,
  statementKind,
  statementsInRange,
  stripComments
} from '../../src/shared/sql/statements'

describe('splitStatements', () => {
  it('splits on semicolons', () => {
    const parts = splitStatements('SELECT 1; SELECT 2; SELECT 3')
    expect(parts.map((p) => p.text)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })

  it('ignores a semicolon inside a string literal', () => {
    const parts = splitStatements("SELECT 'a;b' AS x; SELECT 2")
    expect(parts.map((p) => p.text)).toEqual(["SELECT 'a;b' AS x", 'SELECT 2'])
  })

  it('handles doubled quotes inside a literal', () => {
    const parts = splitStatements("SELECT 'it''s; fine'; SELECT 2")
    expect(parts).toHaveLength(2)
    expect(parts[0].text).toBe("SELECT 'it''s; fine'")
  })

  it('ignores a semicolon inside a bracketed identifier', () => {
    const parts = splitStatements('SELECT [a;b] FROM t; SELECT 2')
    expect(parts).toHaveLength(2)
    expect(parts[0].text).toBe('SELECT [a;b] FROM t')
  })

  it('ignores a semicolon inside a quoted identifier', () => {
    const parts = splitStatements('SELECT "a;b" FROM t; SELECT 2')
    expect(parts).toHaveLength(2)
  })

  it('ignores a semicolon inside a line comment', () => {
    const parts = splitStatements('SELECT 1 -- comment; not a split\nFROM t; SELECT 2')
    expect(parts).toHaveLength(2)
    expect(parts[0].text).toContain('FROM t')
  })

  it('ignores a semicolon inside a block comment', () => {
    const parts = splitStatements('SELECT 1 /* a; b */ FROM t; SELECT 2')
    expect(parts).toHaveLength(2)
  })

  it('handles nested block comments, which T-SQL allows', () => {
    const parts = splitStatements('SELECT 1 /* outer /* inner; */ still; */ FROM t; SELECT 2')
    expect(parts).toHaveLength(2)
    expect(parts[1].text).toBe('SELECT 2')
  })

  it('drops empty statements and comment-only fragments', () => {
    expect(splitStatements(';;;')).toEqual([])
    expect(splitStatements('-- just a comment')).toEqual([])
    expect(splitStatements('/* only a comment */')).toEqual([])
    expect(splitStatements('   \n\t  ')).toEqual([])
    expect(splitStatements('')).toEqual([])
  })

  it('records the offsets and line of each statement', () => {
    const sql = 'SELECT 1;\nSELECT 2;\n\nSELECT 3'
    const parts = splitStatements(sql)
    expect(parts[0].startLine).toBe(1)
    expect(parts[1].startLine).toBe(2)
    expect(parts[2].startLine).toBe(4)
    expect(sql.slice(parts[1].start, parts[1].end)).toBe('SELECT 2')
  })
})

describe('splitBatches', () => {
  it('does not split on semicolons', () => {
    const parts = splitBatches('SELECT 1; SELECT 2; SELECT 3')
    expect(parts).toHaveLength(1)
  })

  it('keeps a BEGIN…END body intact', () => {
    const sql = 'IF 1=1\nBEGIN\n  SET @x = 1;\n  SET @y = 2;\nEND'
    expect(splitBatches(sql)).toHaveLength(1)
    // The statement-level split would wrongly cut this up.
    expect(splitStatements(sql).length).toBeGreaterThan(1)
  })

  it('splits on a GO alone on its line, case-insensitively', () => {
    expect(splitBatches('SELECT 1\nGO\nSELECT 2')).toHaveLength(2)
    expect(splitBatches('SELECT 1\ngo\nSELECT 2')).toHaveLength(2)
    expect(splitBatches('SELECT 1\n  GO  \nSELECT 2')).toHaveLength(2)
  })

  it('does not treat GO as a separator when other code shares the line', () => {
    expect(splitBatches('SELECT 1 GO SELECT 2')).toHaveLength(1)
    expect(splitBatches('SELECT * FROM GO_TABLE')).toHaveLength(1)
    expect(splitBatches("SELECT 'GO'")).toHaveLength(1)
    // A code segment can start mid-line right after a literal.
    expect(splitBatches("SELECT 'x' GO")).toHaveLength(1)
  })

  it('ignores GO inside comments and literals', () => {
    expect(splitBatches('SELECT 1\n-- GO\nFROM t')).toHaveLength(1)
    expect(splitBatches('SELECT 1\n/*\nGO\n*/\nFROM t')).toHaveLength(1)
  })

  it('repeats a batch for GO <count>', () => {
    const parts = splitBatches('SELECT 1\nGO 3')
    expect(parts).toHaveLength(3)
    expect(parts.every((p) => p.text === 'SELECT 1')).toBe(true)
  })

  it('treats GO 1 and a bare GO the same', () => {
    expect(splitBatches('SELECT 1\nGO 1')).toHaveLength(1)
  })

  it('handles a trailing GO with nothing after it', () => {
    expect(splitBatches('SELECT 1\nGO\n')).toHaveLength(1)
  })
})

describe('statementAt', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3'

  it('finds the statement containing the offset', () => {
    expect(statementAt(sql, 2)?.text).toBe('SELECT 1')
    expect(statementAt(sql, 12)?.text).toBe('SELECT 2')
    expect(statementAt(sql, sql.length)?.text).toBe('SELECT 3')
  })

  it('falls back to the preceding statement when the cursor is between them', () => {
    expect(statementAt(sql, 9)?.text).toBe('SELECT 1')
  })

  it('returns null for an empty script', () => {
    expect(statementAt('', 0)).toBeNull()
    expect(statementAt('   ', 1)).toBeNull()
  })
})

describe('statementsInRange', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3'

  it('returns the statements a selection overlaps', () => {
    expect(statementsInRange(sql, 0, 8).map((s) => s.text)).toEqual(['SELECT 1'])
    expect(statementsInRange(sql, 0, 15).map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('accepts a backwards range', () => {
    expect(statementsInRange(sql, 15, 0).map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2'])
  })
})

describe('stripComments', () => {
  it('removes line and block comments', () => {
    const stripped = stripComments('SELECT 1 -- hi\nFROM t')
    expect(stripped).not.toContain('hi')
    expect(stripped.replace(/[ \t]+/g, ' ')).toBe('SELECT 1 \nFROM t')
    expect(stripComments('SELECT /* hi */ 1')).toContain('SELECT')
    expect(stripComments('SELECT /* hi */ 1')).not.toContain('hi')
  })

  it('keeps comment-like text inside a literal', () => {
    expect(stripComments("SELECT '-- not a comment'")).toContain('-- not a comment')
  })
})

describe('statementKind / returnsRows', () => {
  it('reads the leading keyword past comments', () => {
    expect(statementKind('SELECT 1')).toBe('SELECT')
    expect(statementKind('-- c\nUPDATE t SET a=1')).toBe('UPDATE')
    expect(statementKind('/* c */ delete from t')).toBe('DELETE')
    expect(statementKind('')).toBe('')
  })

  it('recognises row-returning statements', () => {
    expect(returnsRows('SELECT 1')).toBe(true)
    expect(returnsRows('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true)
    expect(returnsRows('EXEC sp_who')).toBe(true)
    expect(returnsRows('UPDATE t SET a = 1')).toBe(false)
    // An OUTPUT clause makes a DML statement return rows too.
    expect(returnsRows('DELETE FROM t OUTPUT deleted.id')).toBe(true)
  })
})

describe('asCreateOrAlter', () => {
  it('rewrites a procedure definition past its header comments', () => {
    const sql = '-- Author: me\n/* notes */\nCREATE PROCEDURE [dbo].[p] AS SELECT 1'
    expect(asCreateOrAlter(sql)).toBe(
      '-- Author: me\n/* notes */\nCREATE OR ALTER PROCEDURE [dbo].[p] AS SELECT 1'
    )
  })

  it('handles functions, views, triggers and PROC, in any case', () => {
    expect(asCreateOrAlter('create function f() returns int as begin return 1 end')).toBe(
      'create OR ALTER function f() returns int as begin return 1 end'
    )
    expect(asCreateOrAlter('CREATE VIEW v AS SELECT 1')).toBe('CREATE OR ALTER VIEW v AS SELECT 1')
    expect(asCreateOrAlter('CREATE PROC p AS SELECT 1')).toBe('CREATE OR ALTER PROC p AS SELECT 1')
    expect(asCreateOrAlter('CREATE TRIGGER t ON x AFTER INSERT AS SELECT 1')).toBe(
      'CREATE OR ALTER TRIGGER t ON x AFTER INSERT AS SELECT 1'
    )
  })

  it('leaves everything else alone', () => {
    const already = 'CREATE OR ALTER PROCEDURE p AS SELECT 1'
    expect(asCreateOrAlter(already)).toBe(already)
    expect(asCreateOrAlter('CREATE TABLE t (id int)')).toBe('CREATE TABLE t (id int)')
    expect(asCreateOrAlter('SELECT 1 -- CREATE PROCEDURE')).toBe('SELECT 1 -- CREATE PROCEDURE')
    expect(asCreateOrAlter('-- CREATE PROCEDURE p\nSELECT 1')).toBe('-- CREATE PROCEDURE p\nSELECT 1')
  })

  /**
   * SQL Server drops the words of an `OR ALTER` it was sent and keeps the
   * spaces either side of them: `CREATE OR ALTER PROCEDURE` is stored as
   * `CREATE   PROCEDURE`.
   */
  it('reads back the gap SQL Server leaves as one space', () => {
    expect(asCreateOrAlter('CREATE   PROCEDURE dbo.p AS SELECT 1')).toBe(
      'CREATE OR ALTER PROCEDURE dbo.p AS SELECT 1'
    )
    expect(asCreateOrAlter('CREATE \t PROC p AS SELECT 1')).toBe('CREATE OR ALTER PROC p AS SELECT 1')
  })

  it('opens the same script however many times it is saved and read back', () => {
    // What SQL Server keeps of a script it is sent.
    const stored = (script: string): string => script.replace(/\bOR(\s+)ALTER\b/i, '$1')
    const opened = asCreateOrAlter('CREATE PROCEDURE dbo.p AS SELECT 1')
    let script = opened
    for (let save = 0; save < 5; save += 1) script = asCreateOrAlter(stored(script))
    expect(script).toBe(opened)
  })

  it('keeps a line break after CREATE where it was written', () => {
    expect(asCreateOrAlter('CREATE\nPROCEDURE p AS SELECT 1')).toBe(
      'CREATE OR ALTER\nPROCEDURE p AS SELECT 1'
    )
    expect(asCreateOrAlter('CREATE \r\n  PROCEDURE p AS SELECT 1')).toBe(
      'CREATE OR ALTER \r\n  PROCEDURE p AS SELECT 1'
    )
  })
})
