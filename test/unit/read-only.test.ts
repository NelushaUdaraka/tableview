import { describe, expect, it } from 'vitest'
import { findWrite, findWriteInScript } from '../../src/shared/sql/readOnly'

describe('findWrite: what a read-only connection lets through', () => {
  it.each([
    ['a plain SELECT', 'SELECT * FROM dbo.orders'],
    ['keywords in any case', 'select top 10 * from sales.orders where status = 1'],
    ['a common table expression', 'WITH recent AS (SELECT * FROM t) SELECT * FROM recent'],
    ['a CTE written with its leading semicolon', ';WITH x AS (SELECT 1 AS a) SELECT a FROM x'],
    ['a parenthesised query', '(SELECT 1) UNION (SELECT 2)'],
    ['variables', 'DECLARE @n int = 5; SET @n = @n + 1; SELECT TOP (@n) * FROM t'],
    ['session settings', 'SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SELECT 1'],
    ['IDENTITY_INSERT, which is a setting and not an INSERT', 'SET IDENTITY_INSERT dbo.t ON'],
    ['control flow around reads', "IF EXISTS (SELECT 1 FROM t) PRINT 'yes' ELSE PRINT 'no'"],
    ['TRY/CATCH', 'BEGIN TRY SELECT 1/0 END TRY BEGIN CATCH SELECT ERROR_MESSAGE() END CATCH'],
    [
      'a cursor fetched into variables',
      'DECLARE c CURSOR FOR SELECT id FROM t; OPEN c; FETCH NEXT FROM c INTO @id; CLOSE c; DEALLOCATE c'
    ],
    ['a transaction around a locking read', 'BEGIN TRAN; SELECT * FROM t WITH (UPDLOCK); ROLLBACK'],
    ['switching database', 'USE reporting; SELECT 1'],
    ['waiting', "WAITFOR DELAY '00:00:01'; SELECT GETDATE()"],
    ['JSON output', 'SELECT * FROM t FOR JSON AUTO'],
    [
      'write words in comments and literals',
      "-- DELETE FROM t\nSELECT 'DROP TABLE x' AS hint /* UPDATE t */ FROM t"
    ],
    ['write words as quoted names', 'SELECT [update], "delete" FROM [insert]'],
    [
      'names that only contain a write word',
      'SELECT created_at, is_deleted, @update FROM dbo.InsertLog JOIN sys.dm_exec_requests r ON 1 = 1'
    ],
    ['a name with a letter outside ASCII before the word', 'SELECT ÄDELETE FROM t'],
    ['nothing at all', ''],
    ['only a comment', '-- nothing to run']
  ])('lets through %s', (_label, sql) => {
    expect(findWrite(sql)).toBeNull()
  })
})

describe('findWrite: what it refuses', () => {
  it.each([
    ['DELETE FROM dbo.orders WHERE id = 1', 'DELETE', 'DELETE changes data'],
    ['update t set a = 1', 'UPDATE', 'UPDATE changes data'],
    ['INSERT INTO t VALUES (1)', 'INSERT', 'INSERT changes data'],
    ['MERGE t USING s ON t.id = s.id WHEN MATCHED THEN DELETE;', 'MERGE', 'MERGE changes data'],
    ['TRUNCATE TABLE t', 'TRUNCATE', 'TRUNCATE changes data'],
    ['WITH x AS (SELECT * FROM t) DELETE FROM x', 'DELETE', 'DELETE changes data'],
    ['SELECT * INTO dbo.copy FROM t', 'INTO', 'SELECT … INTO creates a table'],
    ['SELECT * INTO [dbo].[copy] FROM t', 'INTO', 'SELECT … INTO creates a table'],
    // Read-only mode does not tell scratch space from the database itself.
    ['SELECT * INTO #scratch FROM t', 'INTO', 'SELECT … INTO creates a table'],
    ['CREATE TABLE x (a int)', 'CREATE', 'CREATE changes the schema'],
    ['ALTER TABLE t ADD c int', 'ALTER', 'ALTER changes the schema'],
    ['DROP TABLE t', 'DROP', 'DROP changes the schema'],
    ['SELECT 1; DISABLE TRIGGER trg ON t', 'TRIGGER', 'ENABLE or DISABLE TRIGGER changes the schema'],
    ['GRANT SELECT ON t TO bob', 'GRANT', 'GRANT changes permissions'],
    ['EXEC dbo.purge_orders', 'EXEC', 'EXEC runs a procedure, which could change anything'],
    ["exec('DROP TABLE t')", 'EXEC', 'EXEC runs a procedure, which could change anything'],
    [
      "EXECUTE sp_executesql N'DELETE FROM t'",
      'EXECUTE',
      'EXECUTE runs a procedure, which could change anything'
    ],
    [
      "SELECT * FROM OPENQUERY(srv, 'SELECT 1')",
      'OPENQUERY',
      'OPENQUERY runs a query on another server, out of sight'
    ],
    ["DBCC CHECKIDENT ('t', RESEED, 0)", 'DBCC', 'DBCC acts on the server itself'],
    ["BACKUP DATABASE x TO DISK = 'x.bak'", 'BACKUP', 'BACKUP acts on the server itself'],
    ['KILL 52', 'KILL', 'KILL acts on the server itself']
  ])('refuses %s', (sql, keyword, description) => {
    expect(findWrite(sql)).toEqual({ keyword, line: 1, description })
  })

  // SQL Server runs a name at the head of a batch as a procedure, EXEC or not.
  it('refuses a procedure called by name at the start of a batch', () => {
    expect(findWrite("sp_rename 'dbo.t', 't2'")).toEqual({
      keyword: 'sp_rename',
      line: 1,
      description: '“sp_rename” is not a statement read-only mode knows to be a read'
    })
  })

  it('refuses a bracketed procedure name at the start of a batch', () => {
    expect(findWrite('[dbo].[purge] 1')).toMatchObject({ keyword: '[dbo].[purge]', line: 1 })
  })

  it('refuses a statement it does not know at the start of a batch', () => {
    expect(findWrite('DISABLE TRIGGER trg ON t')).toMatchObject({ keyword: 'DISABLE', line: 1 })
  })

  it('reports the first thing that writes, and the line it is on', () => {
    expect(findWrite('SELECT 1\nDELETE FROM t\nDROP TABLE t')).toMatchObject({
      keyword: 'DELETE',
      line: 2
    })
    expect(findWrite('SELECT 1\n\n  update t SET a = 1')).toMatchObject({ keyword: 'UPDATE', line: 3 })
  })

  it('counts the lines a comment or a literal spans', () => {
    expect(findWrite('/* one\ntwo */ SELECT 1 -- DROP\nINSERT INTO t VALUES (1)')).toMatchObject({
      keyword: 'INSERT',
      line: 3
    })
    expect(findWrite("SELECT 'a\nb'\nDELETE FROM t")).toMatchObject({ keyword: 'DELETE', line: 3 })
  })
})

describe('findWriteInScript', () => {
  it('checks every batch, counting lines through the whole script', () => {
    expect(findWriteInScript('SELECT 1\nGO\nSELECT 2\nGO\nDELETE FROM t')).toMatchObject({
      keyword: 'DELETE',
      line: 5
    })
  })

  it('treats a name after GO as the start of a batch', () => {
    expect(findWriteInScript('SELECT 1\nGO\nsp_who')).toMatchObject({ keyword: 'sp_who', line: 3 })
  })

  it('does not take a GO inside a literal for a batch break', () => {
    expect(findWriteInScript("SELECT 'x\nGO\nsp_who'")).toBeNull()
  })

  it('lets a script of reads through', () => {
    expect(findWriteInScript('SELECT 1\nGO\nWITH x AS (SELECT 2 AS a) SELECT a FROM x')).toBeNull()
  })
})
