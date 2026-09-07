/**
 * T-SQL identifier and literal escaping.
 *
 * These are the only places in the codebase allowed to interpolate values into
 * SQL text. Everything user-supplied that *can* be a bound parameter is bound
 * instead; identifiers cannot be bound, so they are bracket-quoted here.
 */

/** Wraps an identifier in brackets, escaping any embedded `]`. */
export function quoteIdent(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Identifier must be a non-empty string')
  }
  if (name.includes('\0')) {
    throw new Error('Identifier must not contain a null byte')
  }
  return `[${name.replace(/]/g, ']]')}]`
}

/** `[schema].[object]`, or just `[object]` when no schema is given. */
export function qualify(schema: string | undefined | null, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name)
}

/** Fully qualified with database: `[db].[schema].[object]`. */
export function qualifyWithDatabase(
  database: string | undefined | null,
  schema: string | undefined | null,
  name: string
): string {
  const parts: string[] = []
  if (database) parts.push(quoteIdent(database))
  if (schema) parts.push(quoteIdent(schema))
  else if (database) parts.push('')
  parts.push(quoteIdent(name))
  return parts.join('.')
}

/** Single-quoted literal with `'` doubled. Prefixed with `N` for Unicode. */
export function quoteString(value: string, unicode = true): string {
  const escaped = String(value).replace(/'/g, "''")
  return `${unicode ? 'N' : ''}'${escaped}'`
}

/**
 * Escapes LIKE wildcards so a user's literal text matches literally.
 * Pair with `ESCAPE '\'` on the predicate.
 */
export function escapeLikePattern(value: string): string {
  return String(value).replace(/([\\%_[\]])/g, '\\$1')
}

const IDENT_RE = /^[\p{L}_@#][\p{L}\p{N}@$#_]*$/u

const RESERVED = new Set(
  `ADD ALL ALTER AND ANY AS ASC AUTHORIZATION BACKUP BEGIN BETWEEN BREAK BROWSE BULK BY CASCADE CASE
   CHECK CHECKPOINT CLOSE CLUSTERED COALESCE COLLATE COLUMN COMMIT COMPUTE CONSTRAINT CONTAINS
   CONTAINSTABLE CONTINUE CONVERT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP
   CURRENT_USER CURSOR DATABASE DBCC DEALLOCATE DECLARE DEFAULT DELETE DENY DESC DISK DISTINCT
   DISTRIBUTED DOUBLE DROP DUMP ELSE END ERRLVL ESCAPE EXCEPT EXEC EXECUTE EXISTS EXIT EXTERNAL
   FETCH FILE FILLFACTOR FOR FOREIGN FREETEXT FREETEXTTABLE FROM FULL FUNCTION GOTO GRANT GROUP
   HAVING HOLDLOCK IDENTITY IDENTITYCOL IDENTITY_INSERT IF IN INDEX INNER INSERT INTERSECT INTO IS
   JOIN KEY KILL LEFT LIKE LINENO LOAD MERGE NATIONAL NOCHECK NONCLUSTERED NOT NULL NULLIF OF OFF
   OFFSETS ON OPEN OPENDATASOURCE OPENQUERY OPENROWSET OPENXML OPTION OR ORDER OUTER OVER PERCENT
   PIVOT PLAN PRECISION PRIMARY PRINT PROC PROCEDURE PUBLIC RAISERROR READ READTEXT RECONFIGURE
   REFERENCES REPLICATION RESTORE RESTRICT RETURN REVERT REVOKE RIGHT ROLLBACK ROWCOUNT ROWGUIDCOL
   RULE SAVE SCHEMA SECURITYAUDIT SELECT SEMANTICKEYPHRASETABLE SESSION_USER SET SETUSER SHUTDOWN
   SOME STATISTICS SYSTEM_USER TABLE TABLESAMPLE TEXTSIZE THEN TO TOP TRAN TRANSACTION TRIGGER
   TRUNCATE TRY_CONVERT TSEQUAL UNION UNIQUE UNPIVOT UPDATE UPDATETEXT USE USER VALUES VARYING VIEW
   WAITFOR WHEN WHERE WHILE WITH WITHIN WRITETEXT`
    .split(/\s+/)
    .filter(Boolean)
)

/** True when the identifier can appear unquoted in T-SQL. */
export function isPlainIdentifier(name: string): boolean {
  return IDENT_RE.test(name) && !RESERVED.has(name.toUpperCase())
}

/** Quotes only when necessary — used for generated DDL that humans will read. */
export function maybeQuoteIdent(name: string): string {
  return isPlainIdentifier(name) ? name : quoteIdent(name)
}

/**
 * Splits a possibly-bracketed qualified name into its parts.
 * `[dbo].[my].[table]` -> `['dbo', 'my', 'table']`
 */
export function parseQualifiedName(input: string): string[] {
  const parts: string[] = []
  let current = ''
  let inBracket = false
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (inBracket) {
      if (ch === ']') {
        if (input[i + 1] === ']') {
          current += ']'
          i += 2
          continue
        }
        inBracket = false
        i += 1
        continue
      }
      current += ch
      i += 1
      continue
    }
    if (ch === '[') {
      inBracket = true
      i += 1
      continue
    }
    if (ch === '.') {
      parts.push(current.trim())
      current = ''
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  parts.push(current.trim())
  return parts
}
