/**
 * System-catalog queries backing the schema explorer.
 *
 * These read `sys.*` rather than INFORMATION_SCHEMA because the catalog views
 * expose identity, computed-column, filtered-index and disabled-object details
 * that the ISO views omit.
 *
 * `@object` is always a `[schema].[table]` string passed to OBJECT_ID().
 */

export const LIST_DATABASES = `
SELECT
  d.name                                        AS [name],
  d.database_id                                 AS [databaseId],
  d.state_desc                                  AS [state],
  d.collation_name                              AS [collation],
  CAST(NULL AS decimal(18,2))                   AS [sizeMb]
FROM sys.databases d
WHERE HAS_DBACCESS(d.name) = 1
ORDER BY d.name;
`

export const LIST_SCHEMAS = `
SELECT s.name AS [name]
FROM sys.schemas s
WHERE s.principal_id <> 4 AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
ORDER BY s.name;
`

export const LIST_OBJECTS = `
SELECT
  s.name                        AS [schema],
  t.name                        AS [name],
  'table'                       AS [type],
  CAST(ISNULL(SUM(p.rows), 0) AS bigint) AS [rowCountEstimate]
FROM sys.tables t
INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
LEFT JOIN sys.partitions p
  ON p.object_id = t.object_id AND p.index_id IN (0, 1)
WHERE t.is_ms_shipped = 0
GROUP BY s.name, t.name

UNION ALL

SELECT
  s.name        AS [schema],
  v.name        AS [name],
  'view'        AS [type],
  CAST(NULL AS bigint) AS [rowCountEstimate]
FROM sys.views v
INNER JOIN sys.schemas s ON s.schema_id = v.schema_id
WHERE v.is_ms_shipped = 0

ORDER BY [schema], [name];
`

export const LIST_ROUTINES = `
SELECT
  s.name AS [schema],
  o.name AS [name],
  CASE o.type
    WHEN 'P'  THEN 'procedure'
    WHEN 'FN' THEN 'scalar-function'
    WHEN 'IF' THEN 'table-function'
    WHEN 'TF' THEN 'table-function'
  END    AS [type]
FROM sys.objects o
INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('P', 'FN', 'IF', 'TF')
  AND o.is_ms_shipped = 0
ORDER BY s.name, o.name;
`

export const TABLE_COLUMNS = `
SELECT
  c.name                                          AS [name],
  c.column_id                                     AS [position],
  ty.name                                         AS [dataType],
  c.max_length                                    AS [maxLength],
  c.precision                                     AS [precision],
  c.scale                                         AS [scale],
  c.is_nullable                                   AS [nullable],
  c.is_identity                                   AS [isIdentity],
  c.is_computed                                   AS [isComputed],
  cc.definition                                   AS [computedDefinition],
  dc.definition                                   AS [defaultValue],
  c.collation_name                                AS [collation],
  CAST(ic.seed_value AS nvarchar(64))             AS [identitySeed],
  CAST(ic.increment_value AS nvarchar(64))        AS [identityIncrement],
  CAST(ep.value AS nvarchar(max))                 AS [description]
FROM sys.columns c
INNER JOIN sys.types ty
  ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.computed_columns cc
  ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN sys.default_constraints dc
  ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
LEFT JOIN sys.identity_columns ic
  ON ic.object_id = c.object_id AND ic.column_id = c.column_id
LEFT JOIN sys.extended_properties ep
  ON ep.major_id = c.object_id
 AND ep.minor_id = c.column_id
 AND ep.name = 'MS_Description'
 AND ep.class = 1
WHERE c.object_id = OBJECT_ID(@object)
ORDER BY c.column_id;
`

export const TABLE_PRIMARY_KEY = `
SELECT c.name AS [name], ic.key_ordinal AS [ordinal]
FROM sys.indexes i
INNER JOIN sys.index_columns ic
  ON ic.object_id = i.object_id AND ic.index_id = i.index_id
INNER JOIN sys.columns c
  ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.object_id = OBJECT_ID(@object)
  AND i.is_primary_key = 1
ORDER BY ic.key_ordinal;
`

export const TABLE_INDEXES = `
SELECT
  i.name              AS [indexName],
  i.is_unique         AS [isUnique],
  i.is_primary_key    AS [isPrimaryKey],
  i.type_desc         AS [typeDesc],
  i.is_disabled       AS [isDisabled],
  i.filter_definition AS [filterDefinition],
  c.name              AS [columnName],
  ic.is_descending_key AS [descending],
  ic.is_included_column AS [isIncluded],
  ic.key_ordinal      AS [keyOrdinal],
  ic.index_column_id  AS [indexColumnId]
FROM sys.indexes i
INNER JOIN sys.index_columns ic
  ON ic.object_id = i.object_id AND ic.index_id = i.index_id
INNER JOIN sys.columns c
  ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.object_id = OBJECT_ID(@object)
  AND i.type <> 0
ORDER BY i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id;
`

export const TABLE_FOREIGN_KEYS = `
SELECT
  fk.name                                     AS [name],
  OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS [referencedSchema],
  OBJECT_NAME(fk.referenced_object_id)        AS [referencedTable],
  pc.name                                     AS [columnName],
  rc.name                                     AS [referencedColumn],
  fk.delete_referential_action_desc           AS [onDelete],
  fk.update_referential_action_desc           AS [onUpdate],
  fk.is_disabled                              AS [isDisabled],
  fkc.constraint_column_id                    AS [ordinal]
FROM sys.foreign_keys fk
INNER JOIN sys.foreign_key_columns fkc
  ON fkc.constraint_object_id = fk.object_id
INNER JOIN sys.columns pc
  ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
INNER JOIN sys.columns rc
  ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE fk.parent_object_id = OBJECT_ID(@object)
ORDER BY fk.name, fkc.constraint_column_id;
`

/** Foreign keys pointing *at* this table, for the "referenced by" panel. */
export const TABLE_INBOUND_FOREIGN_KEYS = `
SELECT
  fk.name                                  AS [name],
  OBJECT_SCHEMA_NAME(fk.parent_object_id)  AS [referencedSchema],
  OBJECT_NAME(fk.parent_object_id)         AS [referencedTable],
  rc.name                                  AS [columnName],
  pc.name                                  AS [referencedColumn],
  fk.delete_referential_action_desc        AS [onDelete],
  fk.update_referential_action_desc        AS [onUpdate],
  fk.is_disabled                           AS [isDisabled],
  fkc.constraint_column_id                 AS [ordinal]
FROM sys.foreign_keys fk
INNER JOIN sys.foreign_key_columns fkc
  ON fkc.constraint_object_id = fk.object_id
INNER JOIN sys.columns pc
  ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
INNER JOIN sys.columns rc
  ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE fk.referenced_object_id = OBJECT_ID(@object)
ORDER BY fk.name, fkc.constraint_column_id;
`

export const TABLE_TRIGGERS = `
SELECT
  tr.name                   AS [name],
  tr.is_disabled            AS [isDisabled],
  tr.is_instead_of_trigger  AS [isInsteadOf],
  te.type_desc              AS [event]
FROM sys.triggers tr
INNER JOIN sys.trigger_events te ON te.object_id = tr.object_id
WHERE tr.parent_id = OBJECT_ID(@object)
ORDER BY tr.name, te.type_desc;
`

export const TABLE_CONSTRAINTS = `
SELECT
  cc.name       AS [name],
  'check'       AS [type],
  cc.definition AS [definition],
  c.name        AS [column]
FROM sys.check_constraints cc
LEFT JOIN sys.columns c
  ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id
WHERE cc.parent_object_id = OBJECT_ID(@object)

UNION ALL

SELECT
  dc.name       AS [name],
  'default'     AS [type],
  dc.definition AS [definition],
  c.name        AS [column]
FROM sys.default_constraints dc
INNER JOIN sys.columns c
  ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
WHERE dc.parent_object_id = OBJECT_ID(@object)

UNION ALL

SELECT
  i.name            AS [name],
  'unique'          AS [type],
  STUFF((
    SELECT ', ' + c2.name
    FROM sys.index_columns ic2
    INNER JOIN sys.columns c2
      ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
    WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 0
    ORDER BY ic2.key_ordinal
    FOR XML PATH(''), TYPE
  ).value('.', 'nvarchar(max)'), 1, 2, '') AS [definition],
  CAST(NULL AS sysname) AS [column]
FROM sys.indexes i
WHERE i.object_id = OBJECT_ID(@object)
  AND i.is_unique_constraint = 1

ORDER BY [type], [name];
`

export const TABLE_ROW_ESTIMATE = `
SELECT CAST(ISNULL(SUM(p.rows), 0) AS bigint) AS [rowCountEstimate]
FROM sys.partitions p
WHERE p.object_id = OBJECT_ID(@object) AND p.index_id IN (0, 1);
`

export const OBJECT_DEFINITION_QUERY = `
SELECT OBJECT_DEFINITION(OBJECT_ID(@object)) AS [definition];
`

export const SERVER_INFO = `
SELECT
  CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS [productVersion],
  CAST(SERVERPROPERTY('Edition') AS nvarchar(128))        AS [edition],
  CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(128))   AS [productLevel],
  CAST(SERVERPROPERTY('MachineName') AS nvarchar(128))    AS [machineName],
  DB_NAME()                                               AS [currentDatabase],
  SUSER_SNAME()                                           AS [login],
  CURRENT_USER                                            AS [currentUser],
  @@VERSION                                               AS [versionString];
`

/** Distinct column names across the current database, for editor autocomplete. */
export const AUTOCOMPLETE_COLUMNS = `
SELECT DISTINCT TOP (20000)
  s.name AS [schema],
  t.name AS [table],
  c.name AS [column]
FROM sys.columns c
INNER JOIN sys.tables t ON t.object_id = c.object_id
INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
UNION
SELECT DISTINCT
  s.name, v.name, c.name
FROM sys.columns c
INNER JOIN sys.views v ON v.object_id = c.object_id
INNER JOIN sys.schemas s ON s.schema_id = v.schema_id
WHERE v.is_ms_shipped = 0;
`

/** Databases with ids <= 4 are master/tempdb/model/msdb. */
export function isSystemDatabase(name: string, databaseId?: number): boolean {
  if (typeof databaseId === 'number' && databaseId <= 4) return true
  return ['master', 'tempdb', 'model', 'msdb'].includes(name.toLowerCase())
}
