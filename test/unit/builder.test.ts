import { describe, expect, it } from 'vitest'
import {
  ParamBag,
  buildChangeSetStatements,
  buildInsertStatements,
  buildCountQuery,
  buildCreateTableDdl,
  buildDeleteStatement,
  buildDeleteTemplate,
  buildFilterPredicate,
  buildForeignKeyDdl,
  buildIndexDdl,
  buildInsertStatement,
  buildInsertTemplate,
  buildOrderByClause,
  buildSelectQuery,
  buildSelectTemplate,
  buildUpdateStatement,
  buildUpdateTemplate,
  buildWhereClause,
  renderColumnType,
  splitInList,
  stripLeadingWhere
} from '../../src/shared/sql/builder'
import type { TableColumn, TableStructure } from '../../src/shared/types'

function column(overrides: Partial<TableColumn> = {}): TableColumn {
  return {
    name: 'col',
    position: 1,
    dataType: 'int',
    fullType: 'int',
    maxLength: null,
    precision: null,
    scale: null,
    nullable: true,
    defaultValue: null,
    isIdentity: false,
    isComputed: false,
    isPrimaryKey: false,
    collation: null,
    description: null,
    ...overrides
  }
}

describe('ParamBag', () => {
  it('allocates sequential names', () => {
    const bag = new ParamBag()
    expect(bag.add('a')).toBe('@p0')
    expect(bag.add('b')).toBe('@p1')
    expect(bag.all()).toEqual([
      { name: 'p0', value: 'a' },
      { name: 'p1', value: 'b' }
    ])
  })

  it('honours a custom prefix', () => {
    expect(new ParamBag('k').add(1)).toBe('@k0')
  })
})

describe('splitInList', () => {
  it('splits a plain list', () => {
    expect(splitInList('a, b ,c')).toEqual(['a', 'b', 'c'])
  })

  it('strips quotes and keeps commas inside them', () => {
    expect(splitInList("'a,b', 'c'")).toEqual(['a,b', 'c'])
  })

  it('unescapes doubled quotes', () => {
    expect(splitInList("'it''s'")).toEqual(["it's"])
  })

  it('drops empty entries', () => {
    expect(splitInList('a,,b,')).toEqual(['a', 'b'])
    expect(splitInList('')).toEqual([])
  })
})

describe('buildFilterPredicate', () => {
  it('binds a value for comparison operators', () => {
    const bag = new ParamBag()
    expect(buildFilterPredicate({ column: 'a', operator: '=', value: '1' }, bag)).toBe('[a] = @p0')
    expect(bag.all()).toEqual([{ name: 'p0', value: '1' }])
  })

  it('emits no parameter for null checks', () => {
    const bag = new ParamBag()
    expect(buildFilterPredicate({ column: 'a', operator: 'is null' }, bag)).toBe('[a] IS NULL')
    expect(buildFilterPredicate({ column: 'a', operator: 'is not null' }, bag)).toBe(
      '[a] IS NOT NULL'
    )
    expect(bag.size).toBe(0)
  })

  it('escapes wildcards for contains / starts with / ends with', () => {
    const bag = new ParamBag()
    expect(buildFilterPredicate({ column: 'a', operator: 'contains', value: '50%' }, bag)).toBe(
      "[a] LIKE @p0 ESCAPE '\\'"
    )
    expect(bag.all()[0].value).toBe('%50\\%%')

    const starts = new ParamBag()
    buildFilterPredicate({ column: 'a', operator: 'starts with', value: 'x_' }, starts)
    expect(starts.all()[0].value).toBe('x\\_%')

    const ends = new ParamBag()
    buildFilterPredicate({ column: 'a', operator: 'ends with', value: 'x' }, ends)
    expect(ends.all()[0].value).toBe('%x')
  })

  it('passes a LIKE pattern through unescaped', () => {
    const bag = new ParamBag()
    expect(buildFilterPredicate({ column: 'a', operator: 'like', value: '%x%' }, bag)).toBe(
      '[a] LIKE @p0'
    )
    expect(bag.all()[0].value).toBe('%x%')
  })

  it('expands IN into one parameter per item', () => {
    const bag = new ParamBag()
    expect(buildFilterPredicate({ column: 'a', operator: 'in', value: '1,2,3' }, bag)).toBe(
      '[a] IN (@p0, @p1, @p2)'
    )
    expect(bag.size).toBe(3)
  })

  it('makes an empty IN list match nothing rather than everything', () => {
    const bag = new ParamBag()
    expect(buildFilterPredicate({ column: 'a', operator: 'in', value: '' }, bag)).toBe('1 = 0')
    expect(buildFilterPredicate({ column: 'a', operator: 'not in', value: '' }, bag)).toBe('1 = 1')
  })

  it('binds both ends of BETWEEN', () => {
    const bag = new ParamBag()
    expect(
      buildFilterPredicate({ column: 'a', operator: 'between', value: '1', value2: '9' }, bag)
    ).toBe('[a] BETWEEN @p0 AND @p1')
    expect(bag.all().map((p) => p.value)).toEqual(['1', '9'])
  })

  it('quotes the column name', () => {
    const bag = new ParamBag()
    expect(buildFilterPredicate({ column: 'weird ] col', operator: '=', value: 'x' }, bag)).toBe(
      '[weird ]] col] = @p0'
    )
  })

  it('rejects an unknown operator', () => {
    expect(() =>
      // @ts-expect-error deliberately invalid
      buildFilterPredicate({ column: 'a', operator: 'DROP TABLE', value: '' }, new ParamBag())
    ).toThrow(/Unsupported filter operator/)
  })

  it('never interpolates the value into the SQL text', () => {
    const bag = new ParamBag()
    const predicate = buildFilterPredicate(
      { column: 'a', operator: '=', value: "x' OR 1=1 --" },
      bag
    )
    expect(predicate).toBe('[a] = @p0')
    expect(predicate).not.toContain('OR 1=1')
  })
})

describe('buildWhereClause', () => {
  it('returns an empty string with no filters', () => {
    expect(buildWhereClause([])).toBe('')
  })

  it('joins with AND by default', () => {
    expect(
      buildWhereClause([
        { column: 'a', operator: '=', value: '1' },
        { column: 'b', operator: '=', value: '2' }
      ])
    ).toBe('WHERE [a] = @p0 AND [b] = @p1')
  })

  it('honours an OR conjunction', () => {
    expect(
      buildWhereClause([
        { column: 'a', operator: '=', value: '1' },
        { column: 'b', operator: '=', value: '2', conjunction: 'OR' }
      ])
    ).toBe('WHERE [a] = @p0 OR [b] = @p1')
  })

  it('ignores the conjunction on the first filter', () => {
    expect(buildWhereClause([{ column: 'a', operator: '=', value: '1', conjunction: 'OR' }])).toBe(
      'WHERE [a] = @p0'
    )
  })
})

describe('buildOrderByClause', () => {
  it('falls back to a constant order so OFFSET/FETCH is valid', () => {
    expect(buildOrderByClause([])).toBe('ORDER BY (SELECT NULL)')
  })

  it('renders directions and multiple keys', () => {
    expect(
      buildOrderByClause([
        { column: 'a', direction: 'asc' },
        { column: 'b', direction: 'desc' }
      ])
    ).toBe('ORDER BY [a] ASC, [b] DESC')
  })
})

describe('buildSelectQuery', () => {
  it('builds a paged select', () => {
    const { sql } = buildSelectQuery({
      schema: 'dbo',
      table: 'customers',
      offset: 40,
      limit: 20,
      sorts: [{ column: 'id', direction: 'asc' }]
    })
    expect(sql).toContain('SELECT *')
    expect(sql).toContain('FROM [dbo].[customers]')
    expect(sql).toContain('ORDER BY [id] ASC')
    expect(sql).toContain('OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY')
  })

  it('lists explicit columns when given', () => {
    const { sql } = buildSelectQuery({ schema: 'dbo', table: 't', columns: ['a', 'b'] })
    expect(sql).toContain('SELECT [a], [b]')
  })

  it('omits paging when no limit is given', () => {
    const { sql } = buildSelectQuery({ schema: 'dbo', table: 't' })
    expect(sql).not.toContain('OFFSET')
  })

  it('coerces a negative or fractional offset', () => {
    const { sql } = buildSelectQuery({ schema: 'dbo', table: 't', offset: -5, limit: 10.7 })
    expect(sql).toContain('OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY')
  })

  it('uses the raw WHERE when supplied, and binds nothing', () => {
    const { sql, params } = buildSelectQuery({
      schema: 'dbo',
      table: 't',
      rawWhere: 'WHERE a > 1',
      filters: [{ column: 'ignored', operator: '=', value: 'x' }]
    })
    expect(sql).toContain('WHERE a > 1')
    expect(params).toEqual([])
  })

  it('binds filter values as parameters', () => {
    const { sql, params } = buildSelectQuery({
      schema: 'dbo',
      table: 't',
      filters: [{ column: 'a', operator: '=', value: 'x' }]
    })
    expect(sql).toContain('WHERE [a] = @p0')
    expect(params).toEqual([{ name: 'p0', value: 'x' }])
  })
})

describe('buildCountQuery', () => {
  it('counts with the same predicate', () => {
    const { sql, params } = buildCountQuery({
      schema: 'dbo',
      table: 't',
      filters: [{ column: 'a', operator: '>', value: '5' }]
    })
    expect(sql).toContain('COUNT_BIG(*)')
    expect(sql).toContain('WHERE [a] > @p0')
    expect(params).toHaveLength(1)
  })
})

describe('stripLeadingWhere', () => {
  it('removes an optional leading WHERE', () => {
    expect(stripLeadingWhere('WHERE a = 1')).toBe('a = 1')
    expect(stripLeadingWhere('  where  a = 1 ')).toBe('a = 1')
    expect(stripLeadingWhere('a = 1')).toBe('a = 1')
  })

  it('does not strip a column that merely starts with "where"', () => {
    expect(stripLeadingWhere('wherehouse = 1')).toBe('wherehouse = 1')
  })
})

describe('mutation builders', () => {
  it('builds a parameterised INSERT', () => {
    const { sql, params } = buildInsertStatement('dbo', 'customers', { email: 'a@b', age: 30 })
    expect(sql).toBe('INSERT INTO [dbo].[customers] ([email], [age]) VALUES (@p0, @p1)')
    expect(params.map((p) => p.value)).toEqual(['a@b', 30])
  })

  it('uses DEFAULT VALUES when there is nothing to insert', () => {
    const { sql, params } = buildInsertStatement('dbo', 't', {})
    expect(sql).toBe('INSERT INTO [dbo].[t] DEFAULT VALUES')
    expect(params).toEqual([])
  })

  it('builds a parameterised UPDATE keyed on the primary key', () => {
    const { sql, params } = buildUpdateStatement('dbo', 't', { id: 7 }, { name: 'x' })
    expect(sql).toBe('UPDATE [dbo].[t] SET [name] = @p0 WHERE [id] = @p1')
    expect(params.map((p) => p.value)).toEqual(['x', 7])
  })

  it('matches a NULL key column with IS NULL rather than =', () => {
    const { sql, params } = buildUpdateStatement('dbo', 't', { a: null, b: 1 }, { c: 2 })
    expect(sql).toBe('UPDATE [dbo].[t] SET [c] = @p0 WHERE [a] IS NULL AND [b] = @p1')
    expect(params).toHaveLength(2)
  })

  it('builds a DELETE', () => {
    const { sql } = buildDeleteStatement('dbo', 't', { id: 1 })
    expect(sql).toBe('DELETE FROM [dbo].[t] WHERE [id] = @p0')
  })

  it('refuses to write a statement that would hit every row', () => {
    expect(() => buildDeleteStatement('dbo', 't', {})).toThrow(/no key columns/)
    expect(() => buildUpdateStatement('dbo', 't', {}, { a: 1 })).toThrow(/no key columns/)
  })

  it('refuses an UPDATE with nothing to change', () => {
    expect(() => buildUpdateStatement('dbo', 't', { id: 1 }, {})).toThrow(/no changed columns/)
  })

  it('quotes awkward table and column names', () => {
    const { sql } = buildUpdateStatement('odd name', 'weird ] table', { 'id ] col': 1 }, { "v's": 2 })
    expect(sql).toBe(
      "UPDATE [odd name].[weird ]] table] SET [v's] = @p0 WHERE [id ]] col] = @p1"
    )
  })

  it('builds a change set as deletes, then updates, then inserts', () => {
    const built = buildChangeSetStatements({
      connectionId: 'c1',
      schema: 'dbo',
      table: 't',
      inserts: [{ tempId: 'new-0', values: { name: 'c' } }],
      updates: [{ key: { id: 2 }, changes: { name: 'b' } }],
      deletes: [{ key: { id: 1 } }, { key: { id: 3 } }]
    })
    expect(built.map((query) => query.sql)).toEqual([
      'DELETE FROM [dbo].[t] WHERE [id] = @p0',
      'DELETE FROM [dbo].[t] WHERE [id] = @p0',
      'UPDATE [dbo].[t] SET [name] = @p0 WHERE [id] = @p1',
      'INSERT INTO [dbo].[t] ([name]) VALUES (@p0)'
    ])
    expect(built.map((query) => query.params.map((p) => p.value))).toEqual([[1], [3], ['b', 2], ['c']])
  })

  it('gathers inserts into the same columns into multi-row statements', () => {
    const built = buildChangeSetStatements({
      connectionId: 'c1',
      schema: 'dbo',
      table: 't',
      inserts: [
        { tempId: 'new-0', values: { a: 1, b: 'x' } },
        { tempId: 'new-1', values: { a: 2, b: 'y' } },
        { tempId: 'new-2', values: { a: 3 } },
        { tempId: 'new-3', values: {} },
        { tempId: 'new-4', values: { a: 4 } }
      ],
      updates: [],
      deletes: []
    })
    expect(built.map((query) => query.sql)).toEqual([
      'INSERT INTO [dbo].[t] ([a], [b]) VALUES\n  (@p0, @p1),\n  (@p2, @p3)',
      'INSERT INTO [dbo].[t] ([a]) VALUES (@p0)',
      'INSERT INTO [dbo].[t] DEFAULT VALUES',
      'INSERT INTO [dbo].[t] ([a]) VALUES (@p0)'
    ])
    expect(built[0].params.map((p) => p.value)).toEqual([1, 'x', 2, 'y'])
  })

  it('splits a long run of inserts to stay under the parameter and row limits', () => {
    const rows = (count: number, width: number) =>
      Array.from({ length: count }, (_, row) =>
        Object.fromEntries(Array.from({ length: width }, (_, col) => [`c${col}`, row]))
      )
    // 2000 parameters at most: 400 rows of five columns.
    expect(buildInsertStatements('dbo', 't', rows(1000, 5)).map((q) => q.params.length)).toEqual([
      2000, 2000, 1000
    ])
    // 1000 rows at most, however narrow.
    expect(buildInsertStatements('dbo', 't', rows(2500, 1)).map((q) => q.params.length)).toEqual([
      1000, 1000, 500
    ])
  })
})

describe('renderColumnType', () => {
  it('renders character lengths, halving the byte length for wide types', () => {
    expect(renderColumnType({ dataType: 'varchar', maxLength: 50, precision: null, scale: null })).toBe(
      'varchar(50)'
    )
    expect(renderColumnType({ dataType: 'nvarchar', maxLength: 100, precision: null, scale: null })).toBe(
      'nvarchar(50)'
    )
  })

  it('renders MAX', () => {
    expect(renderColumnType({ dataType: 'varchar', maxLength: -1, precision: null, scale: null })).toBe(
      'varchar(max)'
    )
  })

  it('renders precision and scale', () => {
    expect(renderColumnType({ dataType: 'decimal', maxLength: null, precision: 18, scale: 2 })).toBe(
      'decimal(18, 2)'
    )
  })

  it('renders fractional-second scale', () => {
    expect(renderColumnType({ dataType: 'datetime2', maxLength: null, precision: null, scale: 3 })).toBe(
      'datetime2(3)'
    )
  })

  it('omits the default float precision', () => {
    expect(renderColumnType({ dataType: 'float', maxLength: null, precision: 53, scale: null })).toBe(
      'float'
    )
    expect(renderColumnType({ dataType: 'float', maxLength: null, precision: 24, scale: null })).toBe(
      'float(24)'
    )
  })

  it('passes simple types through', () => {
    expect(renderColumnType({ dataType: 'int', maxLength: 4, precision: 10, scale: 0 })).toBe('int')
  })
})

describe('DDL generation', () => {
  const structure: TableStructure = {
    schema: 'dbo',
    name: 'customers',
    type: 'table',
    primaryKey: ['id'],
    columns: [
      column({ name: 'id', dataType: 'int', isIdentity: true, identitySeed: '1', identityIncrement: '1', nullable: false, isPrimaryKey: true }),
      column({ name: 'email', dataType: 'nvarchar', maxLength: 510, nullable: false }),
      column({ name: 'total', dataType: 'decimal', precision: 18, scale: 2, defaultValue: '((0))' }),
      column({ name: 'doubled', isComputed: true, computedDefinition: '([total]*(2))' })
    ],
    indexes: [
      {
        name: 'PK_customers',
        isUnique: true,
        isPrimaryKey: true,
        isClustered: true,
        isDisabled: false,
        filterDefinition: null,
        columns: [{ name: 'id', descending: false, isIncluded: false }]
      },
      {
        name: 'IX_email',
        isUnique: false,
        isPrimaryKey: false,
        isClustered: false,
        isDisabled: false,
        filterDefinition: '([email] IS NOT NULL)',
        columns: [
          { name: 'email', descending: true, isIncluded: false },
          { name: 'total', descending: false, isIncluded: true }
        ]
      }
    ],
    foreignKeys: [],
    triggers: [],
    constraints: [{ name: 'CK_total', type: 'check', definition: '([total]>=(0))', column: null }],
    rowCountEstimate: 4
  }

  it('renders a CREATE TABLE with identity, defaults and computed columns', () => {
    const ddl = buildCreateTableDdl(structure)
    expect(ddl).toContain('CREATE TABLE [dbo].[customers] (')
    expect(ddl).toContain('[id] int IDENTITY(1, 1) NOT NULL')
    expect(ddl).toContain('[email] nvarchar(255) NOT NULL')
    expect(ddl).toContain('[total] decimal(18, 2) NULL DEFAULT ((0))')
    expect(ddl).toContain('[doubled] AS ([total]*(2))')
    expect(ddl).toContain('CONSTRAINT [PK_customers] PRIMARY KEY CLUSTERED ([id])')
    expect(ddl).toContain('CONSTRAINT [CK_total] CHECK ([total]>=(0))')
  })

  it('emits secondary indexes but not the primary key index', () => {
    const ddl = buildCreateTableDdl(structure)
    expect(ddl).toContain('CREATE NONCLUSTERED INDEX [IX_email]')
    expect(ddl).toContain('([email] DESC)')
    expect(ddl).toContain('INCLUDE ([total])')
    expect(ddl).toContain('WHERE ([email] IS NOT NULL)')
    expect(ddl).not.toContain('CREATE UNIQUE CLUSTERED INDEX [PK_customers]')
  })

  it('declares unique constraints inline and skips their backing index', () => {
    const withUnique: TableStructure = {
      ...structure,
      constraints: [
        ...structure.constraints,
        { name: 'UQ_email', type: 'unique', definition: 'email', column: null }
      ],
      indexes: [
        ...structure.indexes,
        {
          name: 'UQ_email',
          isUnique: true,
          isPrimaryKey: false,
          isClustered: false,
          isDisabled: false,
          filterDefinition: null,
          columns: [{ name: 'email', descending: false, isIncluded: false }]
        }
      ]
    }
    const ddl = buildCreateTableDdl(withUnique)
    expect(ddl).toContain('CONSTRAINT [UQ_email] UNIQUE ([email])')
    expect(ddl).not.toContain('CREATE UNIQUE NONCLUSTERED INDEX [UQ_email]')
  })

  it('renders a foreign key with referential actions', () => {
    const ddl = buildForeignKeyDdl('sales', 'orders', {
      name: 'FK_o_c',
      columns: ['customer_id'],
      referencedSchema: 'dbo',
      referencedTable: 'customers',
      referencedColumns: ['id'],
      onDelete: 'CASCADE',
      onUpdate: 'NO_ACTION',
      isDisabled: false
    })
    expect(ddl).toContain('ALTER TABLE [sales].[orders]')
    expect(ddl).toContain('ADD CONSTRAINT [FK_o_c] FOREIGN KEY ([customer_id])')
    expect(ddl).toContain('REFERENCES [dbo].[customers] ([id])')
    expect(ddl).toContain('ON DELETE CASCADE')
    expect(ddl).not.toContain('ON UPDATE')
  })

  it('renders a clustered index', () => {
    const ddl = buildIndexDdl('dbo', 't', {
      name: 'IX',
      isUnique: true,
      isPrimaryKey: false,
      isClustered: true,
      isDisabled: false,
      filterDefinition: null,
      columns: [{ name: 'a', descending: false, isIncluded: false }]
    })
    expect(ddl).toContain('CREATE UNIQUE CLUSTERED INDEX [IX]')
  })
})

describe('statement templates', () => {
  const structure: TableStructure = {
    schema: 'dbo',
    name: 't',
    type: 'table',
    primaryKey: ['id'],
    columns: [
      column({ name: 'id', isIdentity: true, nullable: false, isPrimaryKey: true }),
      column({ name: 'name', dataType: 'nvarchar', maxLength: 100 }),
      column({ name: 'amount', dataType: 'decimal', precision: 10, scale: 2, nullable: false }),
      column({ name: 'calc', isComputed: true, computedDefinition: '(1)' })
    ],
    indexes: [],
    foreignKeys: [],
    triggers: [],
    constraints: [],
    rowCountEstimate: 0
  }

  it('builds a SELECT with an explicit column list', () => {
    const sql = buildSelectTemplate(structure, 25)
    expect(sql).toContain('SELECT TOP (25)')
    expect(sql).toContain('[id]')
    expect(sql).toContain('FROM [dbo].[t]')
  })

  it('omits identity and computed columns from INSERT', () => {
    const sql = buildInsertTemplate(structure)
    expect(sql).not.toContain('[id]')
    expect(sql).not.toContain('[calc]')
    expect(sql).toContain('[name]')
    expect(sql).toContain('[amount]')
  })

  it('omits the key columns from the UPDATE SET list', () => {
    const sql = buildUpdateTemplate(structure)
    expect(sql).toContain('UPDATE [dbo].[t]')
    expect(sql).toContain('WHERE [id] = 0')
    expect(sql.split('WHERE')[0]).not.toContain('[id] =')
  })

  it('builds a DELETE keyed on the primary key', () => {
    expect(buildDeleteTemplate(structure)).toBe('DELETE FROM [dbo].[t]\nWHERE [id] = 0;')
  })
})
