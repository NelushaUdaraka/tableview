/**
 * Whether a T-SQL script only reads — the check a read-only connection runs
 * before anything is sent.
 *
 * A lexer's answer, not a parser's. It reads the words of the code, with
 * comments, literals and quoted names blanked out, and refuses on any reserved
 * word that changes something; reserved words cannot be bare names, so one
 * found in code is the statement it starts. What it cannot see into it does
 * not guess at: a procedure, dynamic SQL and another server's pass-through
 * query are refused outright, whatever they would have done.
 *
 * That makes it a safety net for the statement run in the wrong window, not a
 * permission. What a connection may actually do is decided by its login.
 *
 * The same reading lists what a script would change for a connection that
 * confirms its writes (`findWritesInScript`), and picks out the statements
 * that cannot be taken back.
 */
import { maskNonCode, splitBatches } from './statements'

export interface WriteStatement {
  /** The word that gives it away — `DELETE`, `INTO` — or what a batch opens with. */
  keyword: string
  /** 1-based, within the text that was checked. */
  line: number
  /** What it would do, as a phrase that starts with the keyword. */
  description: string
}

const CHANGES_DATA = 'changes data'
const CHANGES_SCHEMA = 'changes the schema'
const CHANGES_PERMISSIONS = 'changes permissions'
const RUNS_CODE = 'runs a procedure, which could change anything'
const RUNS_ELSEWHERE = 'runs a query on another server, out of sight'
const ACTS_ON_SERVER = 'acts on the server itself'

/** Reserved words that change something, and what changes. */
const WRITES = new Map<string, string>([
  ['INSERT', CHANGES_DATA],
  ['UPDATE', CHANGES_DATA],
  ['DELETE', CHANGES_DATA],
  ['MERGE', CHANGES_DATA],
  ['TRUNCATE', CHANGES_DATA],
  ['BULK', CHANGES_DATA],
  ['WRITETEXT', CHANGES_DATA],
  ['UPDATETEXT', CHANGES_DATA],
  ['CREATE', CHANGES_SCHEMA],
  ['ALTER', CHANGES_SCHEMA],
  ['DROP', CHANGES_SCHEMA],
  ['ADD', CHANGES_SCHEMA],
  ['GRANT', CHANGES_PERMISSIONS],
  ['REVOKE', CHANGES_PERMISSIONS],
  ['DENY', CHANGES_PERMISSIONS],
  ['SETUSER', 'changes who the connection acts as'],
  ['EXEC', RUNS_CODE],
  ['EXECUTE', RUNS_CODE],
  ['OPENQUERY', RUNS_ELSEWHERE],
  ['OPENROWSET', RUNS_ELSEWHERE],
  ['OPENDATASOURCE', RUNS_ELSEWHERE],
  ['BACKUP', ACTS_ON_SERVER],
  ['RESTORE', ACTS_ON_SERVER],
  ['DUMP', ACTS_ON_SERVER],
  ['LOAD', ACTS_ON_SERVER],
  ['DBCC', ACTS_ON_SERVER],
  ['KILL', ACTS_ON_SERVER],
  ['SHUTDOWN', ACTS_ON_SERVER],
  ['RECONFIGURE', ACTS_ON_SERVER],
  ['CHECKPOINT', ACTS_ON_SERVER]
])

/**
 * What a batch may open with.
 *
 * Checked at the head of each batch because that is where SQL Server runs any
 * other name as a procedure, `EXEC` or not: `sp_rename 'a', 'b'` alone in a
 * batch renames. Statements that only read, and the declarations, settings,
 * cursors, transactions and control flow that go around reads.
 */
const READ_OPENINGS = new Set([
  'SELECT',
  'WITH',
  'DECLARE',
  'SET',
  'PRINT',
  'IF',
  'WHILE',
  'BEGIN',
  'RETURN',
  'RAISERROR',
  'THROW',
  'WAITFOR',
  'USE',
  'COMMIT',
  'ROLLBACK',
  'SAVE',
  'OPEN',
  'FETCH',
  'CLOSE',
  'DEALLOCATE',
  'BREAK',
  'CONTINUE',
  'GOTO',
  'READTEXT',
  'REVERT'
])

const WORD = /[\p{L}_@#][\p{L}\p{N}_@#$]*/gu
const LEADING_WORD = /^[\p{L}_@#][\p{L}\p{N}_@#$]*/u

/** The first thing in one batch that is not a read, or null when all of it reads. */
export function findWrite(batch: string): WriteStatement | null {
  const code = maskNonCode(batch)
  const lineAt = (offset: number): number => {
    let line = 1
    for (let i = 0; i < offset; i += 1) if (code[i] === '\n') line += 1
    return line
  }

  const opening = unknownOpening(batch, code)
  if (opening) {
    return {
      keyword: opening.keyword,
      line: lineAt(opening.offset),
      description: `“${opening.keyword}” is not a statement known to be a read`
    }
  }

  for (const match of code.matchAll(WORD)) {
    const word = match[0].toUpperCase()
    const offset = match.index
    if (word === 'INTO') {
      // FETCH … INTO @a fills variables; INTO anything else makes a table.
      const next = /\s*(\S?)/y
      next.lastIndex = offset + match[0].length
      if (next.exec(code)?.[1] === '@') continue
      return { keyword: word, line: lineAt(offset), description: 'SELECT … INTO creates a table' }
    }
    // A reserved word found only in ENABLE TRIGGER and DISABLE TRIGGER once a
    // CREATE, ALTER or DROP before it has been refused.
    if (word === 'TRIGGER') {
      return {
        keyword: word,
        line: lineAt(offset),
        description: 'ENABLE or DISABLE TRIGGER changes the schema'
      }
    }
    const effect = WRITES.get(word)
    if (effect) return { keyword: word, line: lineAt(offset), description: `${word} ${effect}` }
  }
  return null
}

/** The same check across a script split on `GO`, with lines counted through it. */
export function findWriteInScript(sql: string): WriteStatement | null {
  for (const batch of splitBatches(sql)) {
    const found = findWrite(batch.text)
    if (found) return { ...found, line: batch.startLine + found.line - 1 }
  }
  return null
}

/**
 * What a batch opens with, when it is not something known to read.
 *
 * Writes are left to the scan that follows, which says what they change.
 */
function unknownOpening(batch: string, code: string): { keyword: string; offset: number } | null {
  // `;WITH` and `(SELECT …) UNION …` both open with punctuation.
  const start = /[^\s;(]/.exec(code)
  if (!start) return null

  const word = LEADING_WORD.exec(code.slice(start.index))?.[0]
  if (word) {
    const upper = word.toUpperCase()
    if (READ_OPENINGS.has(upper) || WRITES.has(upper) || upper === 'TRIGGER') return null
    return { keyword: word, offset: start.index }
  }
  // A [bracketed] or "quoted" name runs as a procedure as readily as a bare
  // one; it is shown as it was written.
  return { keyword: /^\S+/.exec(batch.slice(start.index))?.[0] ?? '', offset: start.index }
}

/** A statement that writes, as the confirm-writes question lists it. */
export interface ScriptWrite extends WriteStatement {
  /** The database a `USE` earlier in the script moved to; absent, where the run starts. */
  database?: string
  /**
   * Set on what cannot be taken back — a `DROP`, a `TRUNCATE`, an `UPDATE` or
   * a `DELETE` with no `WHERE` — unless it is on a temp table or a table
   * variable. `name` is what to type before it may run.
   */
  danger?: { name: string; reason: string }
}

interface Token {
  text: string
  upper: string
  start: number
  kind: 'word' | 'name' | 'literal' | 'punct'
}

/** Words, quoted names, literals and the punctuation the scan cares about, in masked code. */
const TOKEN = /[\p{L}_@#][\p{L}\p{N}_@#$]*|\[[^\]]*\]|"[^"]*"|'[^']*'|[();.,]/gu

/** Modules: the body of one is stored, not run, so it is one write however much it holds. */
const MODULES = new Set(['PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW'])

/** What can follow `DROP` before the name of the thing dropped. */
const DROP_KINDS = new Set([
  'TABLE', 'VIEW', 'PROC', 'PROCEDURE', 'FUNCTION', 'DATABASE', 'SCHEMA', 'INDEX', 'TRIGGER',
  'SYNONYM', 'SEQUENCE', 'TYPE', 'USER', 'LOGIN', 'ROLE', 'EXTERNAL', 'FULLTEXT', 'STATISTICS',
  'ASSEMBLY', 'DEFAULT', 'RULE', 'CATALOG', 'STOPLIST', 'AGGREGATE', 'PARTITION', 'SCHEME',
  'SERVER', 'AUDIT', 'SPECIFICATION', 'CERTIFICATE', 'KEY', 'SYMMETRIC', 'ASYMMETRIC', 'MASTER',
  'CREDENTIAL', 'CONTRACT', 'QUEUE', 'SERVICE', 'ROUTE', 'MESSAGE', 'ENDPOINT', 'EVENT', 'SESSION',
  'NOTIFICATION', 'APPLICATION', 'AVAILABILITY', 'GROUP', 'BROKER', 'PRIORITY', 'XML', 'COLLECTION',
  'SECURITY', 'POLICY', 'SENSITIVITY', 'CLASSIFICATION', 'DATA', 'SOURCE', 'FILE', 'FORMAT',
  'LIBRARY', 'LANGUAGE', 'RESOURCE', 'POOL', 'WORKLOAD', 'CLASSIFIER', 'SIGNATURE', 'COUNTER',
  'CRYPTOGRAPHIC', 'PROVIDER', 'SEARCH', 'PROPERTY', 'LIST'
])

/**
 * Words that start another statement, which ends an `UPDATE` or `DELETE`
 * still looking for its `WHERE` — T-SQL does not need a `;` between them.
 */
const STATEMENT_STARTS = new Set([
  'SELECT', 'IF', 'ELSE', 'WHILE', 'BEGIN', 'END', 'DECLARE', 'PRINT', 'EXEC', 'EXECUTE', 'RETURN',
  'COMMIT', 'ROLLBACK', 'USE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'INSERT', 'UPDATE', 'DELETE',
  'MERGE', 'OPEN', 'FETCH', 'CLOSE', 'DEALLOCATE', 'RAISERROR', 'THROW', 'WAITFOR', 'SAVE', 'BREAK',
  'CONTINUE', 'GOTO', 'GRANT', 'REVOKE', 'DENY'
])

/**
 * Every statement in a script that writes, in order, with the database it
 * writes in when a `USE` says, and what cannot be taken back.
 *
 * Never empty when `findWriteInScript` finds something, so a script the main
 * process holds back for confirming always has something to show.
 */
export function findWritesInScript(sql: string): ScriptWrite[] {
  const writes: ScriptWrite[] = []
  let database: string | undefined
  for (const batch of splitBatches(sql)) {
    const scanned = scanBatch(batch.text, database)
    database = scanned.database
    for (const write of scanned.writes) {
      writes.push({ ...write, line: batch.startLine + write.line - 1 })
    }
  }
  return writes
}

/** One batch's writes, and the database it leaves the script in. */
function scanBatch(
  batch: string,
  startDatabase: string | undefined
): { writes: ScriptWrite[]; database: string | undefined } {
  const code = maskNonCode(batch)
  const tokens: Token[] = [...code.matchAll(TOKEN)].map((match) => {
    const text = match[0]
    const first = text[0]
    const kind =
      first === '[' || first === '"'
        ? 'name'
        : first === "'"
          ? 'literal'
          : /[();.,]/.test(first)
            ? 'punct'
            : 'word'
    return { text, upper: text.toUpperCase(), start: match.index, kind }
  })
  const lineAt = (offset: number): number => {
    let line = 1
    for (let i = 0; i < offset; i += 1) if (code[i] === '\n') line += 1
    return line
  }
  const word = (index: number): string =>
    tokens[index]?.kind === 'word' ? tokens[index].upper : (tokens[index]?.text ?? '')

  let database = startDatabase
  const writes: ScriptWrite[] = []
  const add = (offset: number, keyword: string, description: string): ScriptWrite => {
    const write: ScriptWrite = { keyword, line: lineAt(offset), description, database }
    writes.push(write)
    return write
  }

  const opening = unknownOpening(batch, code)
  if (opening) {
    add(
      opening.offset,
      opening.keyword,
      `“${opening.keyword}” is not a statement known to be a read`
    )
  }

  /** The last write of the statement the scan is in; cleared by `;`. */
  let statementWrite = ''
  let sawOutput = false
  let depth = 0
  let caseDepth = 0
  /** An `UPDATE` or `DELETE` that has not yet shown a `WHERE`. */
  let pending: PendingWhere | null = null

  const settle = (): void => {
    if (pending && !pending.hasWhere && pending.name && !isScratch(pending.name.last)) {
      const { write, name } = pending
      write.danger = {
        name: name.last,
        reason:
          write.keyword === 'DELETE'
            ? `has no WHERE, so it deletes every row of ${name.written}`
            : `has no WHERE, so it changes every row of ${name.written}`
      }
    }
    pending = null
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    const previous = word(i - 1)

    if (token.kind === 'punct') {
      if (token.text === '(') depth += 1
      else if (token.text === ')') {
        depth -= 1
        if (pending && depth < pending.depth) settle()
      } else if (token.text === ';') {
        settle()
        statementWrite = ''
        sawOutput = false
      }
      continue
    }
    if (token.kind !== 'word') continue
    const upper = token.upper

    if (upper === 'CASE') caseDepth += 1
    else if (upper === 'END' && caseDepth > 0) {
      caseDepth -= 1
      continue
    }

    if (pending && depth === pending.depth) {
      if (upper === 'WHERE') pending.hasWhere = true
      else if (STATEMENT_STARTS.has(upper) && !(caseDepth > 0 && upper === 'ELSE')) settle()
    }

    if (upper === 'OUTPUT') {
      sawOutput = true
      continue
    }
    if (upper === 'USE') {
      const name = readName(batch, tokens, i + 1)
      if (name) database = name.last
      continue
    }

    const write = writeAt(tokens, i, previous, statementWrite, sawOutput)
    if (!write) continue

    // The opening was already said, in its own words: `DISABLE TRIGGER`.
    if (upper === 'TRIGGER' && opening && tokens[i - 1]?.start === opening.offset) continue

    statementWrite = upper
    sawOutput = false
    const added = add(token.start, upper, write)

    if ((upper === 'CREATE' || upper === 'ALTER') && isModule(tokens, i)) break
    if (upper === 'DROP' || upper === 'TRUNCATE') {
      let at = i + 1
      // Past `TABLE IF EXISTS` and the like — but a table may be called `Data`.
      const nameFollows = (index: number): boolean =>
        (tokens[index]?.kind === 'word' && !STATEMENT_STARTS.has(tokens[index].upper)) ||
        tokens[index]?.kind === 'name'
      const ifExists = (index: number): boolean =>
        word(index) === 'IF' && word(index + 1) === 'EXISTS'
      if (upper === 'DROP') {
        while (DROP_KINDS.has(word(at)) && (nameFollows(at + 1) || ifExists(at + 1))) at += 1
        if (ifExists(at)) at += 2
      } else if (word(at) === 'TABLE') at += 1
      const name = readName(batch, tokens, at)
      if (name && !isScratch(name.last)) {
        added.danger = {
          name: name.last,
          reason:
            upper === 'DROP'
              ? `drops ${name.written}, which cannot be undone`
              : `empties ${name.written}, which cannot be undone`
        }
      }
    } else if ((upper === 'UPDATE' || upper === 'DELETE') && !isNotRowWrite(tokens, i)) {
      settle()
      pending = { write: added, depth, name: targetOf(batch, tokens, i), hasWhere: false }
    }
  }
  settle()

  // Whatever the scan made of it, a batch the read-only check refuses is
  // never shown as one that writes nothing.
  if (writes.length === 0) {
    const first = findWrite(batch)
    if (first) writes.push({ ...first, database })
  }
  return { writes, database }
}

/**
 * What the word at `index` does, if it writes as a statement of its own —
 * rather than as part of one already found, like the `INTO` of an `INSERT
 * INTO` or the `DELETE` of a `MERGE … THEN DELETE`.
 */
function writeAt(
  tokens: Token[],
  index: number,
  previous: string,
  statementWrite: string,
  sawOutput: boolean
): string | null {
  const upper = tokens[index].upper
  const next = tokens[index + 1]
  // The last part of a name, `dbo.load`, rather than the word.
  if (previous === '.') return null
  switch (upper) {
    case 'INTO':
      // FETCH … INTO @a and OUTPUT … INTO @t fill variables.
      if (next?.text.startsWith('@')) return null
      if (previous === 'INSERT' || previous === 'MERGE') return null
      if (statementWrite && sawOutput) return null
      return 'SELECT … INTO creates a table'
    case 'TRIGGER':
      if (previous === 'CREATE' || previous === 'ALTER' || previous === 'DROP') return null
      return 'ENABLE or DISABLE TRIGGER changes the schema'
    case 'INSERT':
    case 'UPDATE':
    case 'DELETE':
      // A MERGE's actions, a foreign key's ON DELETE, a cursor's FOR UPDATE,
      // BULK INSERT.
      if (['THEN', 'ON', 'FOR', 'BULK'].includes(previous)) return null
      break
    case 'ADD':
      if (statementWrite === 'ALTER') return null
      break
    case 'ALTER':
      if (previous === 'OR') return null
      if (statementWrite === 'ALTER' && next?.upper === 'COLUMN') return null
      break
    case 'DROP':
      // ALTER TABLE … DROP COLUMN; a DROP TABLE after it is a statement of its own.
      if (statementWrite === 'ALTER' && !DROP_KINDS.has(next?.upper ?? '')) return null
      break
    case 'BULK':
      if (previous === '(') return null
      break
  }
  // A permission list: GRANT INSERT, UPDATE, DELETE ON t TO u.
  if (
    ['GRANT', 'REVOKE', 'DENY'].includes(statementWrite) &&
    (previous === ',' || previous === statementWrite)
  ) {
    return null
  }
  const effect = WRITES.get(upper)
  return effect ? `${upper} ${effect}` : null
}

/** `CREATE [OR ALTER] PROCEDURE` and the like, at `index`. */
function isModule(tokens: Token[], index: number): boolean {
  let at = index + 1
  if (tokens[at]?.upper === 'OR' && tokens[at + 1]?.upper === 'ALTER') at += 2
  return MODULES.has(tokens[at]?.upper ?? '')
}

/** `UPDATE STATISTICS`, and `UPDATE(column)` in a trigger: no rows written. */
function isNotRowWrite(tokens: Token[], index: number): boolean {
  const next = tokens[index + 1]
  return next?.upper === 'STATISTICS' || next?.text === '('
}

/** The table an `UPDATE` or `DELETE` writes to, past `TOP (n) [PERCENT]` and `FROM`. */
function targetOf(batch: string, tokens: Token[], index: number): Written | null {
  let at = index + 1
  if (tokens[at]?.upper === 'TOP') {
    at += 1
    if (tokens[at]?.text === '(') {
      let depth = 0
      for (; at < tokens.length; at += 1) {
        if (tokens[at].text === '(') depth += 1
        else if (tokens[at].text === ')' && --depth === 0) break
      }
      at += 1
    } else {
      at += 1
    }
    if (tokens[at]?.upper === 'PERCENT') at += 1
  }
  if (tokens[at]?.upper === 'FROM') at += 1
  return readName(batch, tokens, at)
}

/** An `UPDATE` or `DELETE` being read for its `WHERE`, at the depth it started at. */
interface PendingWhere {
  write: ScriptWrite
  depth: number
  name: Written | null
  hasWhere: boolean
}

/** A name as written — `[dbo].[Orders]` — and its last part, unquoted: `Orders`. */
interface Written {
  written: string
  last: string
}

/** The possibly multi-part name that starts at `index`, read from the original text. */
function readName(batch: string, tokens: Token[], index: number): Written | null {
  let at = index
  let last: Token | null = null
  const first = tokens[at]
  while (tokens[at] && (tokens[at].kind === 'word' || tokens[at].kind === 'name')) {
    last = tokens[at]
    at += 1
    if (tokens[at]?.text !== '.') break
    // `db..table` skips the schema.
    while (tokens[at]?.text === '.') at += 1
  }
  if (!first || !last) return null
  const raw = batch.slice(last.start, last.start + last.text.length)
  return {
    written: batch.slice(first.start, last.start + last.text.length),
    last: unquote(raw)
  }
}

function unquote(part: string): string {
  if (part.startsWith('[') && part.endsWith(']')) return part.slice(1, -1).replace(/]]/g, ']')
  if (part.startsWith('"') && part.endsWith('"')) return part.slice(1, -1).replace(/""/g, '"')
  return part
}

/** A temp table or a table variable: scratch, gone with the session anyway. */
function isScratch(name: string): boolean {
  return name.startsWith('#') || name.startsWith('@')
}
