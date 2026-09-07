/**
 * T-SQL lexing helpers: splitting a script into runnable statements and
 * locating the statement under the cursor.
 *
 * This is a lexer, not a parser — it only needs to know where string
 * literals, bracketed identifiers and comments start and end so that
 * separators inside them are not mistaken for real separators.
 */

export interface SqlStatement {
  /** Statement text with surrounding whitespace trimmed. */
  text: string
  /** Offset of `text` within the original script. */
  start: number
  /** Offset one past the end of `text`. */
  end: number
  /** 1-based line number the statement starts on. */
  startLine: number
}

interface Token {
  start: number
  end: number
  kind: 'code' | 'string' | 'bracket' | 'quoted' | 'line-comment' | 'block-comment'
}

/** Walks the script, yielding regions so callers can skip non-code. */
function* tokenize(sql: string): Generator<Token> {
  let i = 0
  const len = sql.length
  let codeStart = 0

  const flushCode = (upto: number): Token | null =>
    upto > codeStart ? { start: codeStart, end: upto, kind: 'code' } : null

  while (i < len) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (ch === '-' && next === '-') {
      const code = flushCode(i)
      if (code) yield code
      let j = i + 2
      while (j < len && sql[j] !== '\n') j += 1
      yield { start: i, end: j, kind: 'line-comment' }
      i = j
      codeStart = i
      continue
    }

    if (ch === '/' && next === '*') {
      const code = flushCode(i)
      if (code) yield code
      // T-SQL block comments nest.
      let depth = 1
      let j = i + 2
      while (j < len && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1
          j += 2
        } else {
          j += 1
        }
      }
      yield { start: i, end: j, kind: 'block-comment' }
      i = j
      codeStart = i
      continue
    }

    if (ch === "'") {
      const code = flushCode(i)
      if (code) yield code
      let j = i + 1
      while (j < len) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      yield { start: i, end: j, kind: 'string' }
      i = j
      codeStart = i
      continue
    }

    if (ch === '[') {
      const code = flushCode(i)
      if (code) yield code
      let j = i + 1
      while (j < len) {
        if (sql[j] === ']') {
          if (sql[j + 1] === ']') {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      yield { start: i, end: j, kind: 'bracket' }
      i = j
      codeStart = i
      continue
    }

    if (ch === '"') {
      const code = flushCode(i)
      if (code) yield code
      let j = i + 1
      while (j < len) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      yield { start: i, end: j, kind: 'quoted' }
      i = j
      codeStart = i
      continue
    }

    i += 1
  }

  const tail = flushCode(len)
  if (tail) yield tail
}

export type SeparatorKind = 'semicolon' | 'go'

interface Separator {
  start: number
  end: number
  kind: SeparatorKind
  /** Repeat count from `GO 5`; 1 for everything else. */
  repeat: number
}

/** True when only whitespace separates `offset` from the start of its line. */
function atLineStart(sql: string, offset: number): boolean {
  let i = offset - 1
  while (i >= 0 && (sql[i] === ' ' || sql[i] === '\t')) i -= 1
  return i < 0 || sql[i] === '\n' || sql[i] === '\r'
}

/** True when only whitespace separates `offset` from the end of its line. */
function atLineEnd(sql: string, offset: number): boolean {
  let i = offset
  while (i < sql.length && (sql[i] === ' ' || sql[i] === '\t')) i += 1
  return i >= sql.length || sql[i] === '\n' || sql[i] === '\r'
}

/** Offsets of separators that are real code, not text inside a literal. */
function findSeparators(sql: string, kinds: SeparatorKind[]): Separator[] {
  const wantSemicolon = kinds.includes('semicolon')
  const wantGo = kinds.includes('go')
  const separators: Separator[] = []

  for (const token of tokenize(sql)) {
    if (token.kind !== 'code') continue
    const segment = sql.slice(token.start, token.end)

    if (wantSemicolon) {
      for (let k = 0; k < segment.length; k += 1) {
        if (segment[k] === ';') {
          separators.push({
            start: token.start + k,
            end: token.start + k + 1,
            kind: 'semicolon',
            repeat: 1
          })
        }
      }
    }

    if (wantGo) {
      // `GO` is a batch separator only when it is alone on its line. The
      // line-start/-end checks run against the full script, because a code
      // segment can begin mid-line (right after a string literal, say).
      const goRe = /\bGO\b[ \t]*(\d+)?/gi
      let match: RegExpExecArray | null
      while ((match = goRe.exec(segment)) !== null) {
        const absStart = token.start + match.index
        const absEnd = absStart + match[0].length
        if (!atLineStart(sql, absStart) || !atLineEnd(sql, absEnd)) continue
        const repeat = match[1] ? Math.max(1, Number.parseInt(match[1], 10)) : 1
        separators.push({ start: absStart, end: absEnd, kind: 'go', repeat })
      }
    }
  }

  return separators.sort((a, b) => a.start - b.start)
}

function lineAt(sql: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < sql.length; i += 1) {
    if (sql[i] === '\n') line += 1
  }
  return line
}

/** True when the region contains something other than whitespace and comments. */
function hasExecutableContent(sql: string, start: number, end: number): boolean {
  const slice = sql.slice(start, end)
  let meaningful = ''
  for (const token of tokenize(slice)) {
    if (token.kind === 'line-comment' || token.kind === 'block-comment') continue
    meaningful += slice.slice(token.start, token.end)
  }
  return meaningful.trim().length > 0
}

/**
 * Splits a script on the given separators.
 *
 * `GO` is the batch separator; `;` merely terminates a statement *within* a
 * batch, so splitting on it is only safe for editor conveniences — a
 * `BEGIN … END` body or a stored-procedure definition contains semicolons that
 * do not end the batch.
 */
export function splitOn(sql: string, kinds: SeparatorKind[]): SqlStatement[] {
  if (!sql || sql.trim().length === 0) return []

  const separators = findSeparators(sql, kinds)
  const statements: SqlStatement[] = []
  let cursor = 0

  const push = (rawStart: number, rawEnd: number, repeat = 1): void => {
    if (rawEnd <= rawStart) return
    if (!hasExecutableContent(sql, rawStart, rawEnd)) return
    const raw = sql.slice(rawStart, rawEnd)
    const leading = raw.length - raw.trimStart().length
    const trailing = raw.length - raw.trimEnd().length
    const start = rawStart + leading
    const end = rawEnd - trailing
    if (end <= start) return
    const statement: SqlStatement = {
      text: sql.slice(start, end),
      start,
      end,
      startLine: lineAt(sql, start)
    }
    for (let i = 0; i < repeat; i += 1) statements.push(statement)
  }

  for (const separator of separators) {
    push(cursor, separator.start, separator.repeat)
    cursor = separator.end
  }
  push(cursor, sql.length)

  return statements
}

/**
 * Statement-level split (`;` and `GO`). Use for editor features such as
 * "run the statement under the cursor" — not for executing a whole script.
 */
export function splitStatements(sql: string): SqlStatement[] {
  return splitOn(sql, ['semicolon', 'go'])
}

/**
 * Batch-level split (`GO` only). This is what gets executed: it matches how
 * SSMS and sqlcmd treat a script, and keeps multi-statement bodies intact.
 */
export function splitBatches(sql: string): SqlStatement[] {
  return splitOn(sql, ['go'])
}

/** The statement containing `offset`, or the closest preceding one. */
export function statementAt(sql: string, offset: number): SqlStatement | null {
  const statements = splitStatements(sql)
  if (statements.length === 0) return null

  for (const statement of statements) {
    if (offset >= statement.start && offset <= statement.end) return statement
  }

  // Cursor sits in whitespace between statements: prefer the previous one.
  let previous: SqlStatement | null = null
  for (const statement of statements) {
    if (statement.end < offset) previous = statement
  }
  return previous ?? statements[0]
}

/** Statements overlapping a selected range, for "run selection". */
export function statementsInRange(sql: string, from: number, to: number): SqlStatement[] {
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  return splitStatements(sql).filter((s) => s.start < hi && s.end > lo)
}

/** Strips comments — used when deriving a display label for a statement. */
export function stripComments(sql: string): string {
  let out = ''
  for (const token of tokenize(sql)) {
    if (token.kind === 'line-comment' || token.kind === 'block-comment') {
      out += ' '
      continue
    }
    out += sql.slice(token.start, token.end)
  }
  return out
}

/** The leading keyword of a statement, e.g. `SELECT`, uppercased. */
export function statementKind(sql: string): string {
  const cleaned = stripComments(sql).trim()
  const match = /^([A-Za-z_]+)/.exec(cleaned)
  return match ? match[1].toUpperCase() : ''
}

const ROW_RETURNING = new Set(['SELECT', 'WITH', 'EXEC', 'EXECUTE', 'SHOW', 'DBCC'])

/** Heuristic: will this statement produce a grid of rows? */
export function returnsRows(sql: string): boolean {
  const kind = statementKind(sql)
  if (ROW_RETURNING.has(kind)) return true
  // INSERT/UPDATE/DELETE with an OUTPUT clause also return rows.
  return /\bOUTPUT\b/i.test(stripComments(sql))
}
