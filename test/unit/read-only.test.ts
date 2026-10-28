import { describe, expect, it } from 'vitest'
import { findWrite, findWriteInScript, findWritesInScript } from '../../src/shared/sql/readOnly'

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
    ['only a comment', '-- nothing to run'],
    // The Service Broker words are not reserved, so they can be names.
    ['columns called receive and send', 'SELECT t.receive, t.send, x AS receive FROM t'],
    ['paging with FETCH NEXT', 'SELECT * FROM t ORDER BY id OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY'],
    ['a conversation looked at, not changed', 'SELECT * FROM sys.conversation_endpoints']
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
    ['KILL 52', 'KILL', 'KILL acts on the server itself'],
    // Service Broker: a RECEIVE takes the message off the queue for good.
    [
      'WAITFOR (RECEIVE TOP (1) * FROM dbo.q), TIMEOUT 1000',
      'RECEIVE',
      'RECEIVE takes messages off a queue'
    ],
    ['SELECT 1; RECEIVE * FROM dbo.q', 'RECEIVE', 'RECEIVE takes messages off a queue'],
    ['RECEIVE * FROM dbo.q', 'RECEIVE', 'RECEIVE takes messages off a queue'],
    [
      "DECLARE @h uniqueidentifier; SEND ON CONVERSATION @h (N'x')",
      'SEND ON CONVERSATION',
      'SEND ON CONVERSATION puts a message on a queue'
    ],
    [
      "DECLARE @h uniqueidentifier; BEGIN DIALOG CONVERSATION @h FROM SERVICE a TO SERVICE 'b'",
      'BEGIN DIALOG',
      'BEGIN DIALOG opens a conversation between services'
    ],
    [
      "DECLARE @h uniqueidentifier; BEGIN CONVERSATION TIMER (@h) TIMEOUT = 60",
      'BEGIN CONVERSATION TIMER',
      'BEGIN CONVERSATION TIMER sets a timer on a conversation'
    ],
    ['END CONVERSATION @h', 'END CONVERSATION', 'END CONVERSATION ends a conversation'],
    [
      'SELECT 1; MOVE CONVERSATION @h TO @g',
      'MOVE CONVERSATION',
      'MOVE CONVERSATION moves a conversation to another group'
    ],
    [
      'SELECT NEXT VALUE FOR dbo.order_numbers',
      'NEXT VALUE FOR',
      'NEXT VALUE FOR uses up the next number of a sequence'
    ]
  ])('refuses %s', (sql, keyword, description) => {
    expect(findWrite(sql)).toEqual({ keyword, line: 1, description })
  })

  // SQL Server runs a name at the head of a batch as a procedure, EXEC or not.
  it('refuses a procedure called by name at the start of a batch', () => {
    expect(findWrite("sp_rename 'dbo.t', 't2'")).toEqual({
      keyword: 'sp_rename',
      line: 1,
      description: '“sp_rename” is not a statement known to be a read'
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

describe('findWritesInScript: what a confirm-writes connection lists', () => {
  const keywords = (sql: string): string[] => findWritesInScript(sql).map((write) => write.keyword)

  it('lists nothing for a script of reads', () => {
    expect(findWritesInScript('SELECT 1\nGO\nUSE x; SELECT * FROM t WHERE a = 1')).toEqual([])
  })

  it('lists every statement that writes, with its line through the batches', () => {
    expect(
      findWritesInScript('SELECT 1\nUPDATE t SET a = 1 WHERE id = 2\nGO\nINSERT INTO t VALUES (1)')
    ).toEqual([
      { keyword: 'UPDATE', line: 2, description: 'UPDATE changes data', database: undefined },
      { keyword: 'INSERT', line: 4, description: 'INSERT changes data', database: undefined }
    ])
  })

  it('finds statements with no semicolon between them', () => {
    expect(keywords('UPDATE a SET x = 1 WHERE id = 1\nDELETE FROM b WHERE id = 2\nDROP TABLE c')).toEqual(
      ['UPDATE', 'DELETE', 'DROP']
    )
  })

  it('does not list the parts of a statement already listed', () => {
    expect(keywords('INSERT INTO t (a) SELECT a FROM s')).toEqual(['INSERT'])
    expect(
      keywords(
        'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a ' +
          'WHEN NOT MATCHED THEN INSERT (a) VALUES (s.a) WHEN NOT MATCHED BY SOURCE THEN DELETE;'
      )
    ).toEqual(['MERGE'])
    expect(keywords('ALTER TABLE t ADD c int')).toEqual(['ALTER'])
    expect(keywords('ALTER TABLE t DROP COLUMN c')).toEqual(['ALTER'])
    expect(keywords('ALTER TABLE t ALTER COLUMN c bigint')).toEqual(['ALTER'])
    expect(
      keywords('ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES p (id) ON DELETE CASCADE')
    ).toEqual(['ALTER'])
    expect(keywords('DELETE FROM t OUTPUT deleted.id INTO log (id) WHERE a = 1')).toEqual(['DELETE'])
    expect(keywords('GRANT SELECT, INSERT, UPDATE, DELETE ON t TO bob')).toEqual(['GRANT'])
    expect(keywords("BULK INSERT t FROM 'x.csv'")).toEqual(['BULK'])
    expect(keywords('DISABLE TRIGGER trg ON t')).toEqual(['DISABLE'])
    expect(keywords('CREATE TRIGGER trg ON t AFTER INSERT AS SELECT 1')).toEqual(['CREATE'])
  })

  it('lists a module as one write, whatever its body does', () => {
    expect(
      findWritesInScript(
        'CREATE OR ALTER PROCEDURE dbo.purge AS\nBEGIN\n  DELETE FROM dbo.orders\n  DROP TABLE x\nEND'
      )
    ).toEqual([
      { keyword: 'CREATE', line: 1, description: 'CREATE changes the schema', database: undefined }
    ])
    expect(keywords('ALTER VIEW v AS SELECT 1 AS a\nGO\nDELETE FROM t WHERE a = 1')).toEqual([
      'ALTER',
      'DELETE'
    ])
  })

  it('still lists a SELECT … INTO, and a procedure called by name', () => {
    expect(keywords('SELECT * INTO dbo.copy FROM t')).toEqual(['INTO'])
    expect(keywords('DECLARE @a int; FETCH NEXT FROM c INTO @a')).toEqual([])
    expect(keywords("sp_rename 'a', 'b'")).toEqual(['sp_rename'])
    expect(keywords('INSERT INTO t EXEC dbo.load')).toEqual(['INSERT', 'EXEC'])
  })

  it('lists Service Broker statements, and a sequence used outside another write', () => {
    expect(
      keywords("WAITFOR (RECEIVE TOP (1) * FROM q); SEND ON CONVERSATION @h (N'x')\nEND CONVERSATION @h")
    ).toEqual(['RECEIVE', 'SEND ON CONVERSATION', 'END CONVERSATION'])
    expect(keywords('SELECT NEXT VALUE FOR dbo.s')).toEqual(['NEXT VALUE FOR'])
    expect(keywords('INSERT t (id) VALUES (NEXT VALUE FOR dbo.s)')).toEqual(['INSERT'])
  })

  it('says which database a USE moved to', () => {
    const writes = findWritesInScript(
      'DELETE FROM t WHERE a = 1\nUSE [Sales Archive]\nGO\nUPDATE t SET a = 1 WHERE id = 1'
    )
    expect(writes.map((write) => write.database)).toEqual([undefined, 'Sales Archive'])
  })

  it('lists whatever the read-only check refuses', () => {
    for (const sql of [
      'DECLARE c CURSOR FOR SELECT a FROM t FOR UPDATE',
      'IF UPDATE(a) SELECT 1',
      "exec('x')"
    ]) {
      expect(findWriteInScript(sql)).not.toBeNull()
      expect(findWritesInScript(sql).length).toBeGreaterThan(0)
    }
  })
})

describe('findWritesInScript: what cannot be taken back', () => {
  const dangers = (sql: string): Array<{ name: string; reason: string } | undefined> =>
    findWritesInScript(sql).map((write) => write.danger)

  it('asks for the name before a DROP', () => {
    expect(dangers('DROP TABLE dbo.Orders')).toEqual([
      { name: 'Orders', reason: 'drops dbo.Orders, which cannot be undone' }
    ])
    expect(dangers('DROP TABLE IF EXISTS [dbo].[Order Lines]')[0]?.name).toBe('Order Lines')
    expect(dangers('DROP DATABASE Sales')[0]?.name).toBe('Sales')
    expect(dangers('DROP VIEW v')[0]?.name).toBe('v')
    expect(dangers('DROP INDEX ix_a ON t')[0]?.name).toBe('ix_a')
    // A table may be called by a word that names a kind of object.
    expect(dangers('DROP TABLE Data')[0]?.name).toBe('Data')
    expect(dangers('DROP TABLE dbo.Data, other')[0]?.name).toBe('Data')
  })

  it('asks for the name before a TRUNCATE', () => {
    expect(dangers('TRUNCATE TABLE sales..orders')).toEqual([
      { name: 'orders', reason: 'empties sales..orders, which cannot be undone' }
    ])
  })

  it('asks before an UPDATE or DELETE with no WHERE', () => {
    expect(dangers('UPDATE dbo.orders SET status = 0')).toEqual([
      { name: 'orders', reason: 'has no WHERE, so it changes every row of dbo.orders' }
    ])
    expect(dangers('DELETE FROM [orders]')).toEqual([
      { name: 'orders', reason: 'has no WHERE, so it deletes every row of [orders]' }
    ])
    expect(dangers('DELETE orders')[0]?.name).toBe('orders')
    expect(dangers('DELETE TOP (10) PERCENT FROM orders')[0]?.name).toBe('orders')
    expect(dangers('UPDATE TOP (5) orders SET a = 1')[0]?.name).toBe('orders')
  })

  it('does not ask when the WHERE is there', () => {
    expect(dangers('UPDATE t SET a = 1 WHERE id = 1')).toEqual([undefined])
    expect(dangers('DELETE FROM t WHERE CURRENT OF c')).toEqual([undefined])
    expect(
      dangers("UPDATE t SET a = CASE WHEN b = 1 THEN 'x' ELSE 'y' END WHERE id = 1")
    ).toEqual([undefined])
    expect(dangers('UPDATE t SET a = s.a FROM t JOIN s ON s.id = t.id WHERE s.ok = 1')).toEqual([
      undefined
    ])
  })

  it('does not take a WHERE that belongs to something else', () => {
    expect(dangers('UPDATE t SET a = (SELECT MAX(b) FROM s WHERE s.id = 1)')[0]?.name).toBe('t')
    expect(dangers('DELETE FROM t\nSELECT * FROM s WHERE a = 1')[0]?.name).toBe('t')
    expect(dangers('DELETE FROM t; SELECT * FROM s WHERE a = 1')[0]?.name).toBe('t')
    expect(dangers('IF 1 = 1 BEGIN DELETE FROM t END ELSE SELECT 1 FROM s WHERE a = 1')[0]?.name).toBe(
      't'
    )
    expect(
      dangers('DELETE FROM a\nUPDATE b SET x = 1 WHERE id = 1').map((danger) => danger?.name)
    ).toEqual(['a', undefined])
  })

  it('does not ask about scratch tables or maintenance', () => {
    expect(dangers('DROP TABLE IF EXISTS #work')).toEqual([undefined])
    expect(dangers('TRUNCATE TABLE #work')).toEqual([undefined])
    expect(dangers('DELETE FROM @rows')).toEqual([undefined])
    expect(dangers('UPDATE STATISTICS dbo.orders')).toEqual([undefined])
  })
})
