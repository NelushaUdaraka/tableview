/**
 * What counts as a change to a routine's definition, and what putting one
 * back does to the text.
 *
 * The changes are what the editor marks and what each Revert acts on, so two
 * things matter above all: the changes together must account for every
 * difference and nothing else, and reverting one of them must restore exactly
 * those lines — leaving the other edits where they are.
 */
import { describe, expect, it } from 'vitest'
import {
  anchorLine,
  changeAtLine,
  currentTextOf,
  describeChange,
  diffLines,
  revertEdit,
  splitLines,
  type LineChange
} from '../../../src/renderer/src/lib/lineDiff'

const lines = (text: string): string[] => splitLines(text)

/** The text with one edit applied, the way the editor would apply it. */
function applyEdit(text: string, edit: { from: number; to: number; insert: string }): string {
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
}

/** The current text with one change put back. */
function revert(stored: string, current: string, change: LineChange): string {
  return applyEdit(current, revertEdit(change, lines(stored), currentTextOf(current)))
}

/**
 * Every change put back at once, as edits against the same text — which is
 * how the editor applies them.
 */
function revertAll(stored: string, current: string): string {
  const changes = diffLines(lines(stored), lines(current))
  const edits = changes
    .map((change, index) => ({ ...revertEdit(change, lines(stored), currentTextOf(current)), index }))
    // Applied from the end, so earlier offsets still hold. Two edits can start
    // at the same offset — lines restored just before a run of added lines
    // that is removed, or before and after the last line at once — and done
    // one at a time, the later one has to go first: a removal would otherwise
    // take the restored lines with it, and a second insertion would land in
    // front of the first.
    .sort((a, b) => b.from - a.from || b.to - a.to || b.index - a.index)
  return edits.reduce((text, edit) => applyEdit(text, edit), current)
}

describe('diffLines', () => {
  it('finds nothing in identical texts', () => {
    expect(diffLines(lines('a\nb\nc'), lines('a\nb\nc'))).toEqual([])
    expect(diffLines([''], [''])).toEqual([])
  })

  it('marks a changed line as modified', () => {
    expect(diffLines(lines('a\nb\nc'), lines('a\nB\nc'))).toEqual([
      { kind: 'modified', fromA: 1, toA: 2, fromB: 1, toB: 2 }
    ])
  })

  it('marks inserted lines as added, with nothing on the stored side', () => {
    expect(diffLines(lines('a\nc'), lines('a\nb1\nb2\nc'))).toEqual([
      { kind: 'added', fromA: 1, toA: 1, fromB: 1, toB: 3 }
    ])
  })

  it('marks removed lines as deleted, with nothing on the current side', () => {
    expect(diffLines(lines('a\nb\nc\nd'), lines('a\nd'))).toEqual([
      { kind: 'deleted', fromA: 1, toA: 3, fromB: 1, toB: 1 }
    ])
  })

  it('keeps changes separated by an unchanged line apart', () => {
    const stored = 'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1\n  SELECT 2\n  SELECT 3\nEND'
    const current = 'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 10\n  SELECT 2\n  SELECT 30\nEND'
    expect(diffLines(lines(stored), lines(current))).toEqual([
      { kind: 'modified', fromA: 2, toA: 3, fromB: 2, toB: 3 },
      { kind: 'modified', fromA: 4, toA: 5, fromB: 4, toB: 5 }
    ])
  })

  it('reads a block replaced by more lines as one change', () => {
    expect(diffLines(lines('a\nb\nc\nd'), lines('a\nx\ny\nz\nd'))).toEqual([
      { kind: 'modified', fromA: 1, toA: 3, fromB: 1, toB: 4 }
    ])
  })

  it('handles changes at the very start and the very end', () => {
    expect(diffLines(lines('a\nb'), lines('x\na\nb'))).toEqual([
      { kind: 'added', fromA: 0, toA: 0, fromB: 0, toB: 1 }
    ])
    expect(diffLines(lines('a\nb'), lines('a\nb\nx'))).toEqual([
      { kind: 'added', fromA: 2, toA: 2, fromB: 2, toB: 3 }
    ])
    expect(diffLines(lines('x\na\nb'), lines('a\nb'))).toEqual([
      { kind: 'deleted', fromA: 0, toA: 1, fromB: 0, toB: 0 }
    ])
    expect(diffLines(lines('a\nb\nx'), lines('a\nb'))).toEqual([
      { kind: 'deleted', fromA: 2, toA: 3, fromB: 2, toB: 2 }
    ])
  })

  it('counts a trailing line break as a line', () => {
    // The stored text has a break after END; the editor's does not.
    expect(diffLines(lines('a\nEND\n'), lines('a\nEND'))).toEqual([
      { kind: 'deleted', fromA: 2, toA: 3, fromB: 2, toB: 2 }
    ])
  })

  it('reads a definition stored with CRLF the same as the editor’s LF', () => {
    const stored = 'CREATE PROCEDURE p AS\r\nBEGIN\r\n  SELECT 1\r\nEND\r\n'
    const current = 'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1\nEND\n'
    expect(diffLines(lines(stored), lines(current))).toEqual([])
  })

  it('settles for one change when the texts differ past the limit', () => {
    const stored = ['keep', 'a', 'b', 'c', 'd', 'e', 'f', 'end']
    const current = ['keep', 'u', 'b', 'v', 'd', 'w', 'f', 'end']
    expect(diffLines(stored, current)).toHaveLength(3)
    // Still only the region between the first and last difference.
    expect(diffLines(stored, current, 2)).toEqual([
      { kind: 'modified', fromA: 1, toA: 6, fromB: 1, toB: 6 }
    ])
  })
})

describe('describeChange', () => {
  it('says what kind of change it is and how big', () => {
    expect(describeChange({ kind: 'added', fromA: 1, toA: 1, fromB: 1, toB: 3 })).toBe(
      '2 lines added'
    )
    expect(describeChange({ kind: 'deleted', fromA: 1, toA: 2, fromB: 1, toB: 1 })).toBe(
      '1 line removed'
    )
    expect(describeChange({ kind: 'modified', fromA: 1, toA: 2, fromB: 1, toB: 2 })).toBe(
      '1 line changed'
    )
    expect(describeChange({ kind: 'modified', fromA: 1, toA: 3, fromB: 1, toB: 6 })).toBe(
      '2 lines changed to 5'
    )
  })
})

describe('anchorLine and changeAtLine', () => {
  it('marks a change on its first line', () => {
    const change: LineChange = { kind: 'modified', fromA: 3, toA: 5, fromB: 3, toB: 6 }
    expect(anchorLine(change, 10)).toBe(3)
    expect(changeAtLine([change], 3, 10)).toBe(change)
    expect(changeAtLine([change], 5, 10)).toBe(change)
    expect(changeAtLine([change], 6, 10)).toBeNull()
    expect(changeAtLine([change], 2, 10)).toBeNull()
  })

  it('marks a deletion on the line that now follows it', () => {
    const change: LineChange = { kind: 'deleted', fromA: 2, toA: 4, fromB: 2, toB: 2 }
    expect(anchorLine(change, 5)).toBe(2)
    expect(changeAtLine([change], 2, 5)).toBe(change)
    expect(changeAtLine([change], 1, 5)).toBeNull()
  })

  it('marks a deletion from the end on the last line there is', () => {
    const change: LineChange = { kind: 'deleted', fromA: 3, toA: 5, fromB: 3, toB: 3 }
    expect(anchorLine(change, 3)).toBe(2)
    expect(changeAtLine([change], 2, 3)).toBe(change)
  })
})

describe('revertEdit', () => {
  const cases: [string, string, string][] = [
    ['a modified line', 'a\nb\nc', 'a\nB\nc'],
    ['an added block', 'a\nc', 'a\nb1\nb2\nc'],
    ['a deleted block', 'a\nb\nc\nd', 'a\nd'],
    ['a modified first line', 'a\nb', 'A\nb'],
    ['a modified last line', 'a\nb', 'a\nB'],
    ['lines added at the top', 'a\nb', 'x\ny\na\nb'],
    ['lines added at the end', 'a\nb', 'a\nb\nx\ny'],
    ['lines deleted from the top', 'x\ny\na\nb', 'a\nb'],
    ['lines deleted from the end', 'a\nb\nx\ny', 'a\nb'],
    ['a trailing break removed', 'a\nEND\n', 'a\nEND'],
    ['a trailing break added', 'a\nEND', 'a\nEND\n'],
    ['everything replaced', 'a\nb', 'x'],
    ['everything deleted', 'a\nb\nc', ''],
    ['a document typed into an empty one', '', 'x\ny'],
    ['blank lines added between blank lines', 'a\n\n\nb', 'a\n\n\n\n\nb']
  ]

  for (const [label, stored, current] of cases) {
    it(`puts back ${label}`, () => {
      const changes = diffLines(lines(stored), lines(current))
      expect(changes).toHaveLength(1)
      expect(revert(stored, current, changes[0])).toBe(stored)
    })
  }

  it('puts back one change and leaves the others', () => {
    const stored = 'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1\n  SELECT 2\n  SELECT 3\nEND'
    const current = 'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 10\n  SELECT 2\n  -- gone\nEND\nGO'
    const changes = diffLines(lines(stored), lines(current))
    expect(changes).toHaveLength(3)

    expect(revert(stored, current, changes[0])).toBe(
      'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1\n  SELECT 2\n  -- gone\nEND\nGO'
    )
    expect(revert(stored, current, changes[1])).toBe(
      'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 10\n  SELECT 2\n  SELECT 3\nEND\nGO'
    )
    expect(revert(stored, current, changes[2])).toBe(
      'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 10\n  SELECT 2\n  -- gone\nEND'
    )
  })
})

/**
 * A small deterministic generator, so a failure here is the same failure on
 * every run and on every machine.
 */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0
    state = (state ^ (state + Math.imul(state ^ (state >>> 7), state | 61))) >>> 0
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296
  }
}

/** A short "procedure" drawn from a small vocabulary, so lines repeat. */
function script(next: () => number, length: number): string[] {
  const vocabulary = ['BEGIN', 'END', '', '  SELECT 1', '  SELECT 2', '  -- note', 'GO', '  SET x = 1']
  return Array.from({ length }, () => vocabulary[Math.floor(next() * vocabulary.length)])
}

/** The same script with a handful of lines edited, inserted and removed. */
function mutate(next: () => number, source: string[]): string[] {
  const out = [...source]
  const edits = 1 + Math.floor(next() * 5)
  for (let edit = 0; edit < edits; edit += 1) {
    const at = Math.floor(next() * (out.length + 1))
    const roll = next()
    if (roll < 0.35 && out.length > 1) out.splice(Math.min(at, out.length - 1), 1)
    else if (roll < 0.7) out.splice(at, 0, `  added ${edit}`)
    else if (out.length > 0) out[Math.min(at, out.length - 1)] = `  changed ${edit}`
  }
  return out.length > 0 ? out : ['']
}

/** `stored` with every change except `skip` applied: what one revert should leave. */
function applyExcept(stored: string[], current: string[], changes: LineChange[], skip: number): string[] {
  const out: string[] = []
  let at = 0
  changes.forEach((change, index) => {
    out.push(...stored.slice(at, change.fromA))
    out.push(...(index === skip ? stored.slice(change.fromA, change.toA) : current.slice(change.fromB, change.toB)))
    at = change.toA
  })
  out.push(...stored.slice(at))
  return out
}

describe('diffLines on generated scripts', () => {
  it('accounts for every difference, and puts each one back on its own', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const at = `seed ${seed}`
      const next = random(seed)
      const stored = script(next, 1 + Math.floor(next() * 14))
      const current = mutate(next, stored)
      // A tight limit on some runs, so the coarse answer is held to the same rules.
      const changes = diffLines(stored, current, seed % 4 === 0 ? 3 : undefined)

      // The changes, in order, rebuild the current text from the stored one,
      // and only ever skip lines the two have in common.
      let a = 0
      let b = 0
      changes.forEach((change, index) => {
        expect(change.fromA, at).toBeGreaterThanOrEqual(a)
        expect(stored.slice(a, change.fromA), at).toEqual(current.slice(b, change.fromB))
        expect(change.fromB - b, at).toBe(change.fromA - a)
        // Separate changes are separated by at least one shared line.
        if (index > 0) expect(change.fromA, at).toBeGreaterThan(a)
        expect(change.toA - change.fromA + change.toB - change.fromB, at).toBeGreaterThan(0)
        a = change.toA
        b = change.toB
      })
      expect(stored.slice(a), at).toEqual(current.slice(b))

      const storedText = stored.join('\n')
      const currentText = current.join('\n')

      // Each revert restores exactly its own lines.
      changes.forEach((change, index) => {
        expect(lines(revert(storedText, currentText, change)), at).toEqual(
          applyExcept(stored, current, changes, index)
        )
      })

      // And all of them together restore the stored text.
      expect(revertAll(storedText, currentText), at).toBe(storedText)
    }
  })

  it('keeps a long procedure with a few edits to a few changes', () => {
    const stored = Array.from({ length: 5000 }, (_, index) => `  SELECT ${index}`)
    const current = [...stored]
    current[10] = '  SELECT ten'
    current.splice(2500, 0, '  -- added')
    // One line further on than it was, after the insertion above.
    current.splice(4901, 3)

    expect(diffLines(stored, current)).toEqual([
      { kind: 'modified', fromA: 10, toA: 11, fromB: 10, toB: 11 },
      { kind: 'added', fromA: 2500, toA: 2500, fromB: 2500, toB: 2501 },
      { kind: 'deleted', fromA: 4900, toA: 4903, fromB: 4901, toB: 4901 }
    ])
  })

  it('reports a procedure rewritten end to end as one change', () => {
    // What running the formatter over it looks like: every line differs.
    const stored = Array.from({ length: 3000 }, (_, index) => `select ${index}`)
    const current = stored.map((line) => line.toUpperCase())
    expect(diffLines(stored, current)).toEqual([
      { kind: 'modified', fromA: 0, toA: 3000, fromB: 0, toB: 3000 }
    ])
  })
})
