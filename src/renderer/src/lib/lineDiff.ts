/**
 * Which lines of a script differ from the text it was opened as, grouped into
 * the changes a reader would point at.
 *
 * A routine's definition tab is an editor for something that already exists on
 * the server, so the useful question while editing it is "what have I changed?"
 * — and, when three places have been touched and one of them was a mistake,
 * "put *that* one back". Both need the edit described as separate changes
 * rather than as one before-and-after: this is that description.
 *
 * The comparison is by whole line, like a source-control gutter. Lines are
 * split on any line ending, because `OBJECT_DEFINITION` hands back whatever the
 * routine was created with — CRLF from anything written on Windows — while the
 * editor holds LF; comparing them raw would mark every line of a procedure as
 * changed the moment it opened.
 */

export type ChangeKind = 'added' | 'modified' | 'deleted'

/**
 * One contiguous change: lines of the stored text replaced by lines of the
 * current one. Ranges are 0-based and half-open, so a deletion has an empty
 * current range and an addition an empty stored one.
 */
export interface LineChange {
  kind: ChangeKind
  /** The stored lines this change replaces: `[fromA, toA)`. */
  fromA: number
  toA: number
  /** The current lines that replace them: `[fromB, toB)`. */
  fromB: number
  toB: number
}

/**
 * How many single-line edits the full comparison may go to before it settles
 * for less.
 *
 * The comparison runs on every keystroke, and its cost grows with the number
 * of differences: a few scattered edits cost nothing, while a procedure put
 * through the formatter differs on nearly every line. Past this many edits the
 * region between the first and the last difference is reported as a single
 * change — which, for a document that has been rewritten from end to end, is
 * also the honest description of it.
 */
export const MAX_EDITS = 500

export function splitLines(text: string): string[] {
  return text.split(/\r\n?|\n/)
}

function kindOf(fromA: number, toA: number, fromB: number, toB: number): ChangeKind {
  if (toA === fromA) return 'added'
  if (toB === fromB) return 'deleted'
  return 'modified'
}

function change(fromA: number, toA: number, fromB: number, toB: number): LineChange {
  return { kind: kindOf(fromA, toA, fromB, toB), fromA, toA, fromB, toB }
}

/**
 * The changes that turn `stored` into `current`, in document order.
 *
 * Lines the two share at either end are set aside first: nearly every edit is
 * one small region of a long procedure, so the expensive part — Myers'
 * shortest edit script — only ever sees the lines between the first and the
 * last difference.
 */
export function diffLines(
  stored: readonly string[],
  current: readonly string[],
  maxEdits = MAX_EDITS
): LineChange[] {
  let start = 0
  const shorter = Math.min(stored.length, current.length)
  while (start < shorter && stored[start] === current[start]) start += 1

  let endA = stored.length
  let endB = current.length
  while (endA > start && endB > start && stored[endA - 1] === current[endB - 1]) {
    endA -= 1
    endB -= 1
  }

  if (start === endA && start === endB) return []
  // Only one side has anything left: a pure insertion or deletion, no search.
  if (start === endA || start === endB) return [change(start, endA, start, endB)]

  return (
    shortestEdit(stored, current, start, endA, start, endB, maxEdits) ?? [
      change(start, endA, start, endB)
    ]
  )
}

/**
 * Myers' O(ND) difference algorithm over `a[a0, a1)` and `b[b0, b1)`.
 *
 * Returns null when the two differ by more than `maxEdits` lines, so the
 * caller can fall back to a coarser answer instead of spending the keystroke
 * on a fine one.
 *
 * The furthest-reaching point on each diagonal is kept for every step so the
 * path can be walked back; each step's copy holds only the diagonals that step
 * could reach, which keeps the trace to D² numbers rather than D·(N+M).
 */
function shortestEdit(
  a: readonly string[],
  b: readonly string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  maxEdits: number
): LineChange[] | null {
  const n = a1 - a0
  const m = b1 - b0
  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  // v[offset + k] is the furthest x reached on diagonal k (where k = x - y).
  const v = new Int32Array(2 * max + 3)
  v[offset + 1] = 0
  const trace: Int32Array[] = []

  for (let d = 0; d <= max; d += 1) {
    // The state before step d, for diagonals -(d+1)…d+1 — all step d reads.
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m, a0, b0)
    }
  }
  return null
}

/** Walks the trace back from the end, collecting the runs of edits as changes. */
function backtrack(
  trace: Int32Array[],
  n: number,
  m: number,
  a0: number,
  b0: number
): LineChange[] {
  const changes: LineChange[] = []
  // The change being assembled, as the end it reaches back from.
  let open: { toA: number; toB: number } | null = null
  let x = n
  let y = m

  const close = (fromA: number, fromB: number): void => {
    if (!open) return
    changes.push(change(a0 + fromA, a0 + open.toA, b0 + fromB, b0 + open.toB))
    open = null
  }

  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const saved = trace[d]
    // Diagonal k sits at index k + d + 1 in step d's copy.
    const at = (k: number): number => saved[k + d + 1]
    const k = x - y
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const previousX = at(previousK)
    const previousY = previousX - previousK

    // Lines the two share end whatever change was being assembled.
    if (x > previousX && y > previousY) close(x, y)
    while (x > previousX && y > previousY) {
      x -= 1
      y -= 1
    }
    if (d === 0) break

    // One edit: a stored line removed (x moved) or a current line added (y did).
    if (!open) open = { toA: x, toB: y }
    x = previousX
    y = previousY
  }
  close(x, y)

  return changes.reverse()
}

/** The number of lines a change takes up in the current text. */
export function currentLength(change: LineChange): number {
  return change.toB - change.fromB
}

/**
 * The current line a change is marked on.
 *
 * A change with lines of its own is marked on its first one. A deletion has
 * none: it is marked on the line that now follows it, or — when it took the
 * end of the document with it — on the line before, which is the last one
 * there is.
 */
export function anchorLine(change: LineChange, lineCount: number): number {
  if (change.toB > change.fromB) return change.fromB
  return change.fromB < lineCount ? change.fromB : Math.max(0, lineCount - 1)
}

/** The change a current line belongs to, or is the marker line for. */
export function changeAtLine(
  changes: readonly LineChange[],
  line: number,
  lineCount: number
): LineChange | null {
  for (const entry of changes) {
    if (entry.toB > entry.fromB) {
      if (line >= entry.fromB && line < entry.toB) return entry
    } else if (anchorLine(entry, lineCount) === line) {
      return entry
    }
  }
  return null
}

/**
 * The text edit that puts one change back the way it was stored.
 *
 * Expressed against the current text: replace `[from, to)` with `insert`.
 * Every line is treated as carrying its own line break, which makes most
 * changes a plain swap of whole lines; the end of the document is the
 * exception, because the last line has no break of its own — so a change
 * there has to take the break before it, or give one back, instead.
 */
export function revertEdit(
  change: LineChange,
  stored: readonly string[],
  current: CurrentText
): { from: number; to: number; insert: string } {
  const { lineCount, length, lineStart } = current
  const restored = stored.slice(change.fromA, change.toA)

  if (change.toB < lineCount) {
    // Followed by a line that stays: swap whole lines, breaks included.
    return {
      from: lineStart(change.fromB),
      to: lineStart(change.toB),
      insert: restored.map((line) => `${line}\n`).join('')
    }
  }

  if (change.fromB >= lineCount) {
    // Lines deleted from the very end: they go back after the last line.
    return { from: length, to: length, insert: `\n${restored.join('\n')}` }
  }

  if (restored.length > 0) {
    // Runs to the end of the document: no break after the last line.
    return { from: lineStart(change.fromB), to: length, insert: restored.join('\n') }
  }

  // Lines added at the end are removed along with the break that led to them.
  // (A change cannot take every line: the stored text always has one.)
  return { from: Math.max(0, lineStart(change.fromB) - 1), to: length, insert: '' }
}

/** What `revertEdit` needs to know about the text being edited. */
export interface CurrentText {
  lineCount: number
  /** Length in characters, line breaks counted as one. */
  length: number
  /** Offset the 0-based line starts at. */
  lineStart: (line: number) => number
}

/** The same, for a plain string — what the editor's document is, joined on `\n`. */
export function currentTextOf(text: string): CurrentText {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return { lineCount: starts.length, length: text.length, lineStart: (line) => starts[line] }
}

/** A short account of a change, for a tooltip or the head of its peek. */
export function describeChange(change: LineChange): string {
  const was = change.toA - change.fromA
  const now = change.toB - change.fromB
  const lines = (count: number): string => `${count} ${count === 1 ? 'line' : 'lines'}`
  switch (change.kind) {
    case 'added':
      return `${lines(now)} added`
    case 'deleted':
      return `${lines(was)} removed`
    default:
      return was === now ? `${lines(now)} changed` : `${lines(was)} changed to ${now}`
  }
}
