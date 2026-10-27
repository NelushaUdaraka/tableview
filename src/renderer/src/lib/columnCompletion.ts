/**
 * Column completion for the query editor.
 *
 * lang-sql only offers columns after an explicit `table.`, matched by exact
 * case, and cannot see the tables a statement reads. This finds those tables
 * — `FROM`, `JOIN`, `UPDATE`, `INTO` and the rest, with their aliases — in the
 * statement under the cursor, and offers their columns: all of them for a bare
 * word, one table's after `alias.`, `table.` or `schema.table.`.
 *
 * It reads the statement with a lexer, not a parser, so a half-typed query is
 * read as well as a finished one, and it errs toward offering nothing.
 */
import { isPlainIdentifier, quoteIdent } from '@shared/sql/identifiers'
import { isCodeAt, maskNonCode, statementAt } from '@shared/sql/statements'

export interface TableColumns {
  schema: string
  table: string
  columns: string[]
}

/** The autocomplete map (`schema.table` → columns), looked up without regard to case. */
export interface ColumnIndex {
  qualified: Map<string, TableColumns>
  /** Bare table names; one name can belong to several schemas. */
  bare: Map<string, TableColumns[]>
}

export interface TableReference {
  schema: string | null
  table: string
  alias: string | null
}

export interface ColumnOption {
  label: string
  /** The bracketed name, when the column's name cannot be typed bare. */
  apply?: string
  /** The table it belongs to. */
  detail: string
}

export interface ColumnCompletion {
  /** Where the word being completed starts. */
  from: number
  options: ColumnOption[]
  /** True after `name.`, where only that table's columns are offered. */
  qualified: boolean
}

export function columnIndex(schema: Record<string, string[]>): ColumnIndex {
  const qualified = new Map<string, TableColumns>()
  const bare = new Map<string, TableColumns[]>()
  for (const [key, columns] of Object.entries(schema)) {
    const dot = key.indexOf('.')
    const entry: TableColumns = {
      schema: dot < 0 ? '' : key.slice(0, dot),
      table: dot < 0 ? key : key.slice(dot + 1),
      columns
    }
    qualified.set(key.toLowerCase(), entry)
    const name = entry.table.toLowerCase()
    bare.set(name, [...(bare.get(name) ?? []), entry])
  }
  return { qualified, bare }
}

// --- reading the statement -------------------------------------------------------

interface Tok {
  type: 'ident' | 'quoted' | 'dot' | 'comma' | 'open' | 'close' | 'other'
  /** The name, for an identifier or a quoted name (unescaped). */
  value: string
  start: number
  end: number
}

const IDENT_START = /[\p{L}_@#]/u
const IDENT_PART = /[\p{L}\p{N}_@#$]/u

/**
 * Tokens of the code in `sql`: comments and string literals are skipped, and a
 * quoted name is one token holding the name it spells.
 */
function tokens(sql: string): Tok[] {
  const masked = maskNonCode(sql)
  const out: Tok[] = []
  let i = 0
  while (i < masked.length) {
    const ch = masked[i]
    if (/\s/.test(ch)) {
      i += 1
    } else if (ch === '[' || ch === '"') {
      // The mask blanks what is inside, so the next delimiter is the closing one.
      const close = ch === '[' ? ']' : '"'
      const end = masked.indexOf(close, i + 1)
      const stop = end < 0 ? masked.length : end + 1
      const inner = sql.slice(i + 1, end < 0 ? masked.length : end)
      out.push({ type: 'quoted', value: inner.split(close + close).join(close), start: i, end: stop })
      i = stop
    } else if (ch === "'") {
      const end = masked.indexOf("'", i + 1)
      i = end < 0 ? masked.length : end + 1
    } else if (IDENT_START.test(ch)) {
      let j = i + 1
      while (j < masked.length && IDENT_PART.test(masked[j])) j += 1
      out.push({ type: 'ident', value: sql.slice(i, j), start: i, end: j })
      i = j
    } else {
      const type = ch === '.' ? 'dot' : ch === ',' ? 'comma' : ch === '(' ? 'open' : ch === ')' ? 'close' : 'other'
      let j = i + 1
      if (type === 'other' && /\d/.test(ch)) while (j < masked.length && /[\d.]/.test(masked[j])) j += 1
      out.push({ type, value: ch, start: i, end: j })
      i = j
    }
  }
  return out
}

/** Keywords a table name follows. */
const TABLE_AFTER = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'DELETE', 'INSERT', 'MERGE', 'USING'])

/** Words that cannot be an alias, past the reserved ones `isPlainIdentifier` knows. */
const NOT_ALIAS = new Set(['APPLY', 'OUTPUT', 'OFFSET', 'WINDOW', 'NOLOCK', 'LIMIT'])

function isName(tok: Tok | undefined): boolean {
  if (!tok) return false
  if (tok.type === 'quoted') return true
  return tok.type === 'ident' && isPlainIdentifier(tok.value) && !NOT_ALIAS.has(tok.value.toUpperCase())
}

function isKeyword(tok: Tok | undefined, word: string): boolean {
  return tok?.type === 'ident' && tok.value.toUpperCase() === word
}

/**
 * Reads `[db.][schema.]table [[AS] alias]` from `at`. Returns the reference and
 * where reading stopped, or null when no table name is there — a derived
 * table, a variable, or a keyword (`DELETE FROM`).
 */
function readReference(toks: Tok[], at: number): { ref: TableReference; next: number } | null {
  const parts: string[] = []
  let i = at
  while (isName(toks[i])) {
    parts.push(toks[i].value)
    i += 1
    if (toks[i]?.type !== 'dot') break
    i += 1
    // `db..table` leaves the schema out.
    while (toks[i]?.type === 'dot') {
      parts.push('')
      i += 1
    }
  }
  if (parts.length === 0 || parts[parts.length - 1] === '') return null
  // A table-valued function, or an INSERT's column list: neither is aliased here.
  let alias: string | null = null
  if (toks[i]?.type !== 'open') {
    if (isKeyword(toks[i], 'AS') && isName(toks[i + 1])) {
      alias = toks[i + 1].value
      i += 2
    } else if (isName(toks[i])) {
      alias = toks[i].value
      i += 1
    }
  }
  const table = parts[parts.length - 1]
  const schema = parts.length >= 2 ? parts[parts.length - 2] || null : null
  return { ref: { schema, table, alias }, next: i }
}

/** The tables a statement reads or writes, with their aliases, in order. */
export function tableReferences(sql: string): TableReference[] {
  const toks = tokens(sql)
  const refs: TableReference[] = []
  for (let i = 0; i < toks.length; i += 1) {
    const tok = toks[i]
    if (tok.type !== 'ident') continue
    const word = tok.value.toUpperCase()
    if (!TABLE_AFTER.has(word)) continue
    let read = readReference(toks, i + 1)
    while (read) {
      refs.push(read.ref)
      i = read.next - 1
      // `FROM a, b` lists more than one.
      if (word !== 'FROM' || toks[read.next]?.type !== 'comma') break
      read = readReference(toks, read.next + 1)
    }
  }
  return refs
}

// --- completing -----------------------------------------------------------------

/** Keywords after which a table, an alias or a new name is typed — not a column. */
const NO_COLUMNS_AFTER = new Set([
  ...TABLE_AFTER,
  'AS',
  'TABLE',
  'VIEW',
  'PROC',
  'PROCEDURE',
  'FUNCTION',
  'EXEC',
  'EXECUTE',
  'DATABASE',
  'USE',
  'DECLARE',
  'TRIGGER',
  'INDEX',
  'SCHEMA'
])

function resolve(index: ColumnIndex, ref: { schema: string | null; table: string }): TableColumns | null {
  if (ref.schema) return index.qualified.get(`${ref.schema}.${ref.table}`.toLowerCase()) ?? null
  const found = index.bare.get(ref.table.toLowerCase())
  if (!found || found.length === 0) return null
  return found.find((entry) => entry.schema.toLowerCase() === 'dbo') ?? found[0]
}

/** The table `alias.`, `table.` or `schema.table.` names, given the statement's references. */
function resolveQualifier(
  index: ColumnIndex,
  parts: string[],
  refs: TableReference[]
): TableColumns | null {
  const lower = parts.map((part) => part.toLowerCase())
  if (parts.length === 1) {
    const byAlias = refs.find((ref) => ref.alias?.toLowerCase() === lower[0])
    if (byAlias) return resolve(index, byAlias)
    const byName = refs.find((ref) => ref.table.toLowerCase() === lower[0])
    if (byName) return resolve(index, byName)
    return resolve(index, { schema: null, table: parts[0] })
  }
  const [schema, table] = parts.slice(-2)
  return resolve(index, { schema: schema || null, table })
}

function option(column: string, table: string): ColumnOption {
  return isPlainIdentifier(column)
    ? { label: column, detail: table }
    : { label: column, apply: quoteIdent(column), detail: table }
}

/**
 * The columns to offer at `pos` in `doc`, or null when a column is not what
 * goes there: inside a comment or a literal, after `FROM` and its kind, or a
 * bare position with nothing typed unless completion was asked for.
 */
export function completeColumns(
  doc: string,
  pos: number,
  index: ColumnIndex,
  explicit: boolean
): ColumnCompletion | null {
  if (!isCodeAt(doc, pos)) return null

  let from = pos
  while (from > 0 && IDENT_PART.test(doc[from - 1])) from -= 1
  if (doc[from] === '@' || (doc[from] === '#' && from < pos)) return null

  // The statement the cursor is in: the one it touches, or the one it trails
  // with only whitespace between — past a `;` or a `GO` is a new one.
  const statement = statementAt(doc, pos)
  let start = pos
  let end = pos
  if (statement && statement.start <= pos && doc.slice(statement.end, pos).trim() === '') {
    start = statement.start
    end = Math.max(statement.end, pos)
  }
  const refs = tableReferences(doc.slice(start, end))
  const before = tokens(doc.slice(start, from))

  const last = before[before.length - 1]
  if (last?.type === 'dot' && last.end === from - start) {
    const parts: string[] = []
    let i = before.length - 1
    while (before[i]?.type === 'dot' && (before[i - 1]?.type === 'ident' || before[i - 1]?.type === 'quoted')) {
      parts.unshift(before[i - 1].value)
      i -= 2
    }
    if (parts.length === 0) return null
    const target = resolveQualifier(index, parts, refs)
    if (!target) return null
    return { from, options: target.columns.map((c) => option(c, target.table)), qualified: true }
  }

  if (from === pos && !explicit) return null
  if (last?.type === 'ident' && NO_COLUMNS_AFTER.has(last.value.toUpperCase())) return null

  const options: ColumnOption[] = []
  const seen = new Set<TableColumns>()
  for (const ref of refs) {
    const target = resolve(index, ref)
    if (!target || seen.has(target)) continue
    seen.add(target)
    for (const column of target.columns) options.push(option(column, target.table))
  }
  return options.length > 0 ? { from, options, qualified: false } : null
}
