/**
 * The editor side of a routine's change tracking: the changes follow the
 * document as it is typed into, a peek follows the change it was opened on,
 * and each revert puts back one change — as an edit that Ctrl+Z takes back.
 *
 * Driven through `EditorState` alone, which is everything but the drawing:
 * the gutter and the peek are pictures of exactly this state.
 */
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import {
  changeTracking,
  closePeek,
  nextChange,
  peekedChange,
  previousChange,
  revertAllChanges,
  revertChangeAtCursor,
  revertPeekedChange,
  setBaseline,
  togglePeek,
  trackedChanges
} from '../../../src/renderer/src/lib/changeTracking'

const STORED = [
  'CREATE OR ALTER PROCEDURE dbo.usp_orders AS',
  'BEGIN',
  '  SELECT id',
  '  FROM dbo.orders',
  '  WHERE status = 1',
  '  ORDER BY id',
  'END'
].join('\n')

function editor(doc: string, stored = STORED, cursor = 0): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [history(), changeTracking(stored)]
  })
}

/** Runs a command the way a key binding would, returning the state it leaves. */
function run(command: StateCommand, state: EditorState): { handled: boolean; state: EditorState } {
  let next = state
  const handled = command({ state, dispatch: (tr) => (next = tr.state) })
  return { handled, state: next }
}

/** Replaces a line's text, as typing over it would. */
function retype(state: EditorState, line: number, text: string): EditorState {
  const target = state.doc.line(line)
  return state.update({ changes: { from: target.from, to: target.to, insert: text } }).state
}

/** The cursor, on a 1-based line. */
function at(state: EditorState, line: number): EditorState {
  return state.update({ selection: { anchor: state.doc.line(line).from } }).state
}

/**
 * Three separate edits to the stored procedure, each with an unchanged line
 * on either side:
 *
 *   1  CREATE OR ALTER PROCEDURE dbo.usp_orders AS
 *   2  BEGIN
 *   3    SELECT id, total                       modified
 *   4    FROM dbo.orders
 *   5    JOIN dbo.customers c ON c.id = 1      added
 *   6    WHERE status = 1
 *   7  END                                     ORDER BY removed above it
 */
function threeEdits(): EditorState {
  let state = editor(STORED)
  state = retype(state, 3, '  SELECT id, total')
  state = state.update({
    changes: { from: state.doc.line(4).to, insert: '\n  JOIN dbo.customers c ON c.id = 1' }
  }).state
  state = state.update({
    changes: { from: state.doc.line(7).from - 1, to: state.doc.line(7).to }
  }).state
  return state
}

describe('tracked changes', () => {
  it('starts with none when the document is what is stored', () => {
    expect(trackedChanges(editor(STORED))).toEqual([])
  })

  it('reads CRLF in the stored text as the line breaks the editor has', () => {
    expect(trackedChanges(editor(STORED, STORED.replace(/\n/g, '\r\n')))).toEqual([])
  })

  it('follows the document as it is edited', () => {
    const state = threeEdits()
    expect(trackedChanges(state).map((change) => change.kind)).toEqual([
      'modified',
      'added',
      'deleted'
    ])
  })

  it('measures against a new baseline once one is set', () => {
    let state = threeEdits()
    const saved = state.doc.toString()
    state = state.update({ effects: setBaseline.of(saved) }).state
    expect(trackedChanges(state)).toEqual([])

    state = retype(state, 1, 'CREATE OR ALTER PROCEDURE dbo.usp_orders2 AS')
    expect(trackedChanges(state)).toHaveLength(1)
  })

  it('is empty in an editor that is not tracking anything', () => {
    expect(trackedChanges(EditorState.create({ doc: 'SELECT 1' }))).toEqual([])
  })
})

describe('reverting', () => {
  it('puts back only the change under the cursor', () => {
    const { handled, state } = run(revertChangeAtCursor, at(threeEdits(), 5))
    expect(handled).toBe(true)
    // The added line went; the other two edits are still there.
    expect(state.doc.toString()).toBe(
      [
        'CREATE OR ALTER PROCEDURE dbo.usp_orders AS',
        'BEGIN',
        '  SELECT id, total',
        '  FROM dbo.orders',
        '  WHERE status = 1',
        'END'
      ].join('\n')
    )
    expect(trackedChanges(state).map((change) => change.kind)).toEqual(['modified', 'deleted'])
  })

  it('puts deleted lines back from the line marked for them', () => {
    // The ORDER BY line was taken out from above END, so END carries the mark.
    const { state } = run(revertChangeAtCursor, at(threeEdits(), 7))
    expect(state.doc.toString()).toContain('  WHERE status = 1\n  ORDER BY id\nEND')
    expect(trackedChanges(state).map((change) => change.kind)).toEqual(['modified', 'added'])
  })

  it('does nothing on a line that has not changed', () => {
    const { handled, state } = run(revertChangeAtCursor, at(threeEdits(), 1))
    expect(handled).toBe(false)
    expect(trackedChanges(state)).toHaveLength(3)
  })

  it('puts everything back at once, leaving a cursor in an unchanged line where it was', () => {
    const before = threeEdits()
    const cursor = before.doc.line(2).from + 3
    const { state } = run(revertAllChanges, before.update({ selection: { anchor: cursor } }).state)
    expect(state.doc.toString()).toBe(STORED)
    expect(trackedChanges(state)).toEqual([])
    expect(state.selection.main.head).toBe(cursor)
  })

  it('is taken back by one undo, separately from the typing before it', () => {
    const edited = at(threeEdits(), 3)
    const reverted = run(revertChangeAtCursor, edited).state
    expect(trackedChanges(reverted)).toHaveLength(2)

    const undone = run(undo, reverted).state
    expect(undone.doc.toString()).toBe(edited.doc.toString())
    expect(trackedChanges(undone)).toHaveLength(3)
  })
})

describe('moving between changes', () => {
  it('steps forward from the cursor, opening each change, and wraps round', () => {
    let state = at(threeEdits(), 1)
    const lines: number[] = []
    for (let step = 0; step < 4; step += 1) {
      state = run(nextChange, state).state
      lines.push(state.doc.lineAt(state.selection.main.head).number)
      expect(peekedChange(state)).not.toBeNull()
    }
    // Modified line 3, added line 5, the deletion marked on END (7), then round.
    expect(lines).toEqual([3, 5, 7, 3])
  })

  it('steps back from the change being looked at', () => {
    let state = at(threeEdits(), 1)
    state = run(nextChange, state).state // line 3
    state = run(previousChange, state).state // wraps to the last
    expect(state.doc.lineAt(state.selection.main.head).number).toBe(7)
    state = run(previousChange, state).state
    expect(state.doc.lineAt(state.selection.main.head).number).toBe(5)
  })

  it('counts from the peek rather than the cursor while one is open', () => {
    let state = at(threeEdits(), 1)
    state = run((target) => togglePeek(target, 4), state).state // the added line
    expect(peekedChange(state)?.kind).toBe('added')
    state = run(nextChange, state).state
    expect(peekedChange(state)?.kind).toBe('deleted')
  })

  it('has nowhere to go when nothing has changed', () => {
    expect(run(nextChange, editor(STORED)).handled).toBe(false)
    expect(run(previousChange, editor(STORED)).handled).toBe(false)
  })
})

describe('the peek', () => {
  it('opens on a change from any of its lines, and shuts from the same place', () => {
    let state = threeEdits()
    state = run((target) => togglePeek(target, 2), state).state // 0-based line 2 is line 3
    expect(peekedChange(state)?.kind).toBe('modified')
    state = run((target) => togglePeek(target, 2), state).state
    expect(peekedChange(state)).toBeNull()
  })

  it('does not open on a line that has not changed', () => {
    const { handled } = run((target) => togglePeek(target, 0), threeEdits())
    expect(handled).toBe(false)
  })

  it('stays on its change while other lines are edited', () => {
    let state = run((target) => togglePeek(target, 6), threeEdits()).state
    expect(peekedChange(state)?.kind).toBe('deleted')
    // Two lines typed in above it.
    state = state.update({ changes: { from: 0, insert: '-- one\n-- two\n' } }).state
    expect(peekedChange(state)?.kind).toBe('deleted')
    expect(trackedChanges(state)).toHaveLength(4)
  })

  it('shuts once its change has been typed back the way it was stored', () => {
    let state = run((target) => togglePeek(target, 2), threeEdits()).state
    state = retype(state, 3, '  SELECT id')
    expect(peekedChange(state)).toBeNull()
    expect(trackedChanges(state)).toHaveLength(2)
  })

  it('reverts the change it is open on, and shuts', () => {
    let state = run((target) => togglePeek(target, 4), at(threeEdits(), 1)).state
    state = run(revertPeekedChange, state).state
    expect(state.doc.toString()).not.toContain('JOIN dbo.customers')
    expect(trackedChanges(state)).toHaveLength(2)
    expect(peekedChange(state)).toBeNull()
    // The cursor was elsewhere, and stays there.
    expect(state.selection.main.head).toBe(0)
  })

  it('shuts on Escape, and leaves Escape alone when it is not open', () => {
    let state = run((target) => togglePeek(target, 2), threeEdits()).state
    const closed = run(closePeek, state)
    expect(closed.handled).toBe(true)
    expect(peekedChange(closed.state)).toBeNull()
    state = closed.state
    expect(run(closePeek, state).handled).toBe(false)
  })
})
