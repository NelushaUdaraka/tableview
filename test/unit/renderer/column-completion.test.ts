/**
 * Column completion: finding the tables a statement reads, with their
 * aliases, and offering their columns where a column goes.
 */
import { describe, expect, it } from 'vitest'
import {
  columnIndex,
  completeColumns,
  tableReferences
} from '../../../src/renderer/src/lib/columnCompletion'

const index = columnIndex({
  'dbo.Customers': ['Id', 'Name', 'City'],
  'dbo.Orders': ['Id', 'CustomerId', 'Total'],
  'dbo.Order Details': ['OrderId', 'Quantity', 'Unit Price'],
  'sales.Orders': ['OrderNo', 'Region'],
  'dbo.Keys': ['Key', 'Value']
})

/** Completes at the `|` in `text`. */
function complete(text: string, explicit = false) {
  const pos = text.indexOf('|')
  return completeColumns(text.replace('|', ''), pos, index, explicit)
}

function labels(text: string, explicit = false): string[] | null {
  return complete(text, explicit)?.options.map((o) => `${o.label}:${o.detail}`) ?? null
}

describe('tableReferences', () => {
  it('reads FROM and JOIN tables with their aliases', () => {
    expect(
      tableReferences(
        'SELECT * FROM dbo.Customers AS c INNER JOIN Orders o ON o.CustomerId = c.Id LEFT JOIN [Order Details] WHERE 1 = 1'
      )
    ).toEqual([
      { schema: 'dbo', table: 'Customers', alias: 'c' },
      { schema: null, table: 'Orders', alias: 'o' },
      { schema: null, table: 'Order Details', alias: null }
    ])
  })

  it('reads a comma-separated FROM list', () => {
    expect(tableReferences('SELECT * FROM a x, b, c AS z WHERE 1 = 1')).toEqual([
      { schema: null, table: 'a', alias: 'x' },
      { schema: null, table: 'b', alias: null },
      { schema: null, table: 'c', alias: 'z' }
    ])
  })

  it('reads the tables writes name', () => {
    expect(tableReferences('UPDATE t SET a = 1')).toEqual([{ schema: null, table: 't', alias: null }])
    expect(tableReferences('DELETE FROM dbo.t WHERE a = 1')).toEqual([
      { schema: 'dbo', table: 't', alias: null }
    ])
    expect(tableReferences('INSERT INTO db.dbo.t (a, b) VALUES (1, 2)')).toEqual([
      { schema: 'dbo', table: 't', alias: null }
    ])
    expect(tableReferences('SELECT * FROM db..t')).toEqual([{ schema: null, table: 't', alias: null }])
  })

  it('skips derived tables, hints and names in comments or strings', () => {
    expect(tableReferences('SELECT * FROM (SELECT 1 AS a) d')).toEqual([])
    expect(tableReferences('SELECT * FROM t WITH (NOLOCK)')).toEqual([
      { schema: null, table: 't', alias: null }
    ])
    expect(tableReferences("SELECT 'FROM x' -- FROM y\nFROM z")).toEqual([
      { schema: null, table: 'z', alias: null }
    ])
  })

  it('unescapes bracketed names', () => {
    expect(tableReferences('SELECT * FROM [a]]b] [my alias]')).toEqual([
      { schema: null, table: 'a]b', alias: 'my alias' }
    ])
  })
})

describe('completeColumns', () => {
  it('offers the FROM tables’ columns for a bare word, before or after FROM', () => {
    expect(labels('SELECT Na| FROM Customers')).toEqual(['Id:Customers', 'Name:Customers', 'City:Customers'])
    expect(labels('SELECT * FROM Customers WHERE Ci|')).toEqual([
      'Id:Customers',
      'Name:Customers',
      'City:Customers'
    ])
  })

  it('offers every table’s columns, each table once', () => {
    expect(labels('SELECT T| FROM Customers c JOIN Orders o ON o.CustomerId = c.Id JOIN Customers c2')).toEqual([
      'Id:Customers',
      'Name:Customers',
      'City:Customers',
      'Id:Orders',
      'CustomerId:Orders',
      'Total:Orders'
    ])
  })

  it('offers nothing for an empty word unless asked', () => {
    expect(complete('SELECT * FROM Customers WHERE |')).toBeNull()
    expect(labels('SELECT * FROM Customers WHERE |', true)).toHaveLength(3)
  })

  it('offers no columns where a table or a new name goes', () => {
    expect(complete('SELECT * FROM Cu|')).toBeNull()
    expect(complete('SELECT * FROM Customers c JOIN Or|')).toBeNull()
    expect(complete('SELECT Name AS Nm| FROM Customers')).toBeNull()
    expect(complete('UPDATE Cu|')).toBeNull()
  })

  it('offers nothing in comments, strings, variables or temp tables', () => {
    expect(complete("SELECT 'Na| FROM Customers")).toBeNull()
    expect(complete('SELECT 1 -- Na|\nFROM Customers')).toBeNull()
    expect(complete('SELECT @Na| FROM Customers')).toBeNull()
    expect(complete('SELECT * FROM Customers WHERE #t|')).toBeNull()
  })

  it('resolves an alias, with or without AS, whatever its case', () => {
    expect(labels('SELECT c.| FROM Customers c')).toEqual(['Id:Customers', 'Name:Customers', 'City:Customers'])
    expect(labels('SELECT C.Na| FROM dbo.Customers AS c')).toEqual([
      'Id:Customers',
      'Name:Customers',
      'City:Customers'
    ])
    expect(complete('SELECT o.| FROM Customers c JOIN Orders o')?.qualified).toBe(true)
    expect(labels('SELECT o.| FROM Customers c JOIN sales.Orders o')).toEqual(['OrderNo:Orders', 'Region:Orders'])
  })

  it('resolves a table name or a schema-qualified one, in the FROM list or not', () => {
    expect(labels('SELECT Orders.| FROM Orders')).toEqual(['Id:Orders', 'CustomerId:Orders', 'Total:Orders'])
    expect(labels('SELECT customers.|')).toEqual(['Id:Customers', 'Name:Customers', 'City:Customers'])
    expect(labels('SELECT sales.Orders.|')).toEqual(['OrderNo:Orders', 'Region:Orders'])
    expect(labels('SELECT [dbo].[Order Details].|')).toHaveLength(3)
    expect(labels('SELECT [Order Details].Qu|')).toHaveLength(3)
  })

  it('offers nothing for a qualifier it does not know', () => {
    expect(complete('SELECT x.| FROM Customers c')).toBeNull()
    expect(complete('SELECT 1.|')).toBeNull()
  })

  it('brackets a column whose name cannot be typed bare', () => {
    const options = complete('SELECT d.| FROM [Order Details] d')?.options
    expect(options?.find((o) => o.label === 'Unit Price')?.apply).toBe('[Unit Price]')
    expect(options?.find((o) => o.label === 'Quantity')?.apply).toBeUndefined()
    expect(complete('SELECT k.| FROM Keys k')?.options[0].apply).toBe('[Key]')
  })

  it('keeps to the statement under the cursor', () => {
    expect(labels('SELECT * FROM Orders;\nSELECT Na| FROM Customers')).toEqual([
      'Id:Customers',
      'Name:Customers',
      'City:Customers'
    ])
    // Past the `;` is a new statement, which reads no table yet.
    expect(complete('SELECT * FROM Orders;\nSELECT Na|')).toBeNull()
    expect(labels('SELECT * FROM Orders WHERE \n  Cu|')).toHaveLength(3)
  })

  it('starts the completion at the word being typed', () => {
    expect(complete('SELECT c.Na| FROM Customers c')?.from).toBe('SELECT c.'.length)
    expect(complete('SELECT Na| FROM Customers')?.from).toBe('SELECT '.length)
  })
})
