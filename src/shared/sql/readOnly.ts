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
      description: `“${opening.keyword}” is not a statement read-only mode knows to be a read`
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
