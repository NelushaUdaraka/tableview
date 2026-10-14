/**
 * Change tracking for an editor holding a routine's definition.
 *
 * A routine opened from the schema tree is an edit to something that already
 * exists on the server, so the editor keeps the stored text beside the one
 * being typed and marks where they differ, the way a source-control gutter
 * does: a bar beside lines that were added or changed, a wedge where lines
 * were taken out. Clicking a mark opens a peek under the change showing what
 * the stored text had there, with a Revert that puts back that change alone —
 * the other edits stay as they are. Every revert is an ordinary edit, so
 * Ctrl+Z takes it back.
 *
 * The state lives in one field rather than three, because the peek has to
 * follow its change through every edit and the changes are only known once
 * the edit has been diffed: a separate field could not see the new changes
 * while it was being updated.
 */
import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type StateCommand,
  type Text,
  type Transaction,
  type TransactionSpec
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  keymap
} from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import {
  anchorLine,
  changeAtLine,
  describeChange,
  diffLines,
  revertEdit,
  splitLines,
  type CurrentText,
  type LineChange
} from './lineDiff'

/**
 * Moves the text the changes are measured against — what the server holds
 * once the tab has written its script there.
 */
export const setBaseline = StateEffect.define<string>()

/**
 * Opens the peek on the change marked at a position, or shuts it with null.
 * The position is in the document as the transaction leaves it.
 */
const setPeek = StateEffect.define<number | null>()

interface Tracked {
  /** The stored text, as lines. */
  stored: readonly string[]
  changes: readonly LineChange[]
  /** Where the change the peek is open on is marked; null when it is shut. */
  peek: number | null
}

/** Start of the line a change is marked on. */
function markerPos(doc: Text, change: LineChange): number {
  return doc.line(anchorLine(change, doc.lines) + 1).from
}

/**
 * The peek, moved onto the marker of whichever change now covers the line it
 * was on — or shut, once no change does: reverted, or typed back the way it
 * was stored.
 */
function anchorPeek(doc: Text, changes: readonly LineChange[], peek: number | null): number | null {
  if (peek === null) return null
  const line = doc.lineAt(Math.min(peek, doc.length)).number - 1
  const change = changeAtLine(changes, line, doc.lines)
  return change ? markerPos(doc, change) : null
}

const tracked = StateField.define<Tracked>({
  // Always set up through `changeTracking`, which knows the stored text.
  create: () => ({ stored: [''], changes: [], peek: null }),

  update(value, tr) {
    let stored = value.stored
    let peek = value.peek
    let peekSet = false
    for (const effect of tr.effects) {
      if (effect.is(setBaseline)) stored = splitLines(effect.value)
      else if (effect.is(setPeek)) {
        peek = effect.value
        peekSet = true
      }
    }
    if (!tr.docChanged && stored === value.stored && !peekSet) return value

    const changes =
      tr.docChanged || stored !== value.stored
        ? diffLines(stored, tr.newDoc.toJSON())
        : value.changes
    if (!peekSet && peek !== null && tr.docChanged) peek = tr.changes.mapPos(peek)
    return { stored, changes, peek: anchorPeek(tr.newDoc, changes, peek) }
  }
})

/** The changes an editor's document has against what it is tracking. */
export function trackedChanges(state: EditorState): readonly LineChange[] {
  return state.field(tracked, false)?.changes ?? []
}

/** The change the peek is open on, if it is open. */
export function peekedChange(state: EditorState): LineChange | null {
  const value = state.field(tracked, false)
  if (!value || value.peek === null) return null
  return value.changes.find((change) => markerPos(state.doc, change) === value.peek) ?? null
}

// --- reverting ---------------------------------------------------------------

function currentTextOf(doc: Text): CurrentText {
  return { lineCount: doc.lines, length: doc.length, lineStart: (line) => doc.line(line + 1).from }
}

/**
 * Puts changes back the way they are stored, as one edit.
 *
 * Kept out of the typing it follows in the undo history, so one Ctrl+Z takes
 * back the revert and nothing else.
 */
function revertSpec(state: EditorState, value: Tracked, changes: readonly LineChange[]): TransactionSpec {
  const current = currentTextOf(state.doc)
  return {
    // In document order, which is how simultaneous edits at the same offset
    // land: lines restored above the last line stay above the ones restored
    // after it.
    changes: changes.map((change) => revertEdit(change, value.stored, current)),
    effects: setPeek.of(null),
    annotations: isolateHistory.of('full'),
    userEvent: 'revert'
  }
}

/** Reverts the change on the cursor's line — or marked on it, for a deletion. */
export const revertChangeAtCursor: StateCommand = ({ state, dispatch }) => {
  const value = state.field(tracked, false)
  if (!value) return false
  const line = state.doc.lineAt(state.selection.main.head).number - 1
  const change = changeAtLine(value.changes, line, state.doc.lines)
  if (!change) return false
  dispatch(state.update(revertSpec(state, value, [change])))
  return true
}

/** Reverts the change the peek is open on. */
export const revertPeekedChange: StateCommand = ({ state, dispatch }) => {
  const value = state.field(tracked, false)
  const change = peekedChange(state)
  if (!value || !change) return false
  dispatch(state.update(revertSpec(state, value, [change])))
  return true
}

/**
 * Puts every change back at once.
 *
 * Change by change rather than as one replacement of the whole text, so the
 * lines that never changed are not touched — and a cursor in one of them stays
 * where it is.
 */
export const revertAllChanges: StateCommand = ({ state, dispatch }) => {
  const value = state.field(tracked, false)
  if (!value || value.changes.length === 0) return false
  dispatch(state.update(revertSpec(state, value, value.changes)))
  return true
}

// --- moving between changes -------------------------------------------------

/**
 * Moves to the next or previous change, wrapping round, and opens it.
 *
 * Counted from the change being looked at when the peek is open — its arrows
 * mean "the one after this" — and from the cursor otherwise.
 */
function stepCommand(direction: 1 | -1): StateCommand {
  return ({ state, dispatch }) => {
    const value = state.field(tracked, false)
    if (!value || value.changes.length === 0) return false
    const { doc } = state

    const from = doc.lineAt(value.peek ?? state.selection.main.head).number - 1
    const inside = changeAtLine(value.changes, from, doc.lines)
    const origin = inside ? anchorLine(inside, doc.lines) : from
    const markers = value.changes.map((change) => anchorLine(change, doc.lines))

    let index = -1
    if (direction > 0) {
      index = markers.findIndex((line) => line > origin)
      if (index < 0) index = 0
    } else {
      for (let at = markers.length - 1; at >= 0 && index < 0; at -= 1) {
        if (markers[at] < origin) index = at
      }
      if (index < 0) index = markers.length - 1
    }

    const at = markerPos(doc, value.changes[index])
    dispatch(
      state.update({
        selection: { anchor: at },
        effects: [setPeek.of(at), EditorView.scrollIntoView(at, { y: 'center' })]
      })
    )
    return true
  }
}

export const nextChange = stepCommand(1)
export const previousChange = stepCommand(-1)

export const closePeek: StateCommand = ({ state, dispatch }) => {
  if (state.field(tracked, false)?.peek == null) return false
  dispatch(state.update({ effects: setPeek.of(null) }))
  return true
}

/**
 * Opens the peek on the change at a 0-based line, or shuts it when it is
 * already open there — what clicking a mark in the gutter does.
 */
export function togglePeek(
  target: { state: EditorState; dispatch: (tr: Transaction) => void },
  line: number
): boolean {
  const { state } = target
  const value = state.field(tracked, false)
  if (!value) return false
  const change = changeAtLine(value.changes, line, state.doc.lines)
  if (!change) return false
  const at = markerPos(state.doc, change)
  target.dispatch(state.update({ effects: setPeek.of(value.peek === at ? null : at) }))
  return true
}

// --- the gutter ---------------------------------------------------------------

type MarkKind = 'added' | 'modified' | 'deleted' | 'deleted-last'

class ChangeMark extends GutterMarker {
  // The whole cell takes the click, not just the few pixels of the bar.
  override elementClass = 'cm-changeMarked'

  constructor(
    readonly kind: MarkKind,
    readonly title: string
  ) {
    super()
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof ChangeMark && other.kind === this.kind && other.title === this.title
  }

  override toDOM(): Node {
    const mark = document.createElement('div')
    mark.className = `cm-changeMark cm-changeMark--${this.kind}`
    mark.title = this.title
    return mark
  }
}

/** Marks are rebuilt only when the changes are, not on every cursor move. */
const marksCache = new WeakMap<Tracked, RangeSet<GutterMarker>>()

function marksFor(state: EditorState): RangeSet<GutterMarker> {
  const value = state.field(tracked)
  const cached = marksCache.get(value)
  if (cached) return cached

  const { doc } = state
  const ranges: Range<GutterMarker>[] = []
  for (const change of value.changes) {
    const title = `${describeChange(change)} — click to see what was there, or revert it`
    if (change.toB > change.fromB) {
      const mark = new ChangeMark(change.kind, title)
      for (let line = change.fromB; line < change.toB; line += 1) {
        ranges.push(mark.range(doc.line(line + 1).from))
      }
    } else {
      // Nothing left to put a bar beside: a wedge on the edge the lines were
      // taken from — the top of the line after them, or the foot of the last.
      const kind: MarkKind = change.fromB < doc.lines ? 'deleted' : 'deleted-last'
      ranges.push(new ChangeMark(kind, title).range(markerPos(doc, change)))
    }
  }

  const marks = RangeSet.of(ranges)
  marksCache.set(value, marks)
  return marks
}

const changeGutter = gutter({
  class: 'cm-changeGutter',
  markers: (view) => marksFor(view.state),
  domEventHandlers: {
    mousedown: (view, block) => togglePeek(view, view.state.doc.lineAt(block.from).number - 1)
  }
})

// --- the peek -------------------------------------------------------------------

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * The strip under a change: which change it is, what the stored text had
 * there, and what can be done about it.
 *
 * Its buttons act on the peek as the editor has it when they are clicked, not
 * on the change this widget was drawn for — a widget that compares equal is
 * kept across edits, and its idea of where the change is would go stale.
 */
class PeekWidget extends WidgetType {
  constructor(
    readonly change: LineChange,
    readonly stored: readonly string[],
    readonly index: number,
    readonly total: number
  ) {
    super()
  }

  override eq(other: PeekWidget): boolean {
    return (
      other.stored === this.stored &&
      other.index === this.index &&
      other.total === this.total &&
      other.change.kind === this.change.kind &&
      other.change.fromA === this.change.fromA &&
      other.change.toA === this.change.toA &&
      other.change.fromB === this.change.fromB &&
      other.change.toB === this.change.toB
    )
  }

  override toDOM(view: EditorView): HTMLElement {
    const { change } = this
    const root = element('div', `cm-changePeek cm-changePeek--${change.kind}`)

    const button = (label: string, title: string, run: () => void, extra = ''): HTMLElement => {
      const node = element('button', `cm-changePeek__btn ${extra}`.trim(), label) as HTMLButtonElement
      node.type = 'button'
      node.title = title
      // The editor keeps the focus, and with it the cursor where it was.
      node.addEventListener('mousedown', (event) => event.preventDefault())
      node.addEventListener('click', (event) => {
        event.preventDefault()
        run()
      })
      return node
    }

    /** A button drawn with one of the window's icons rather than a typed glyph. */
    const iconButton = (path: string, title: string, run: () => void, extra = ''): HTMLElement => {
      const node = button('', title, run, `cm-changePeek__btn--icon ${extra}`.trim())
      node.setAttribute('aria-label', title)
      node.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
        `stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
      return node
    }

    const head = element('div', 'cm-changePeek__head')
    head.append(
      element('span', 'cm-changePeek__count', `Change ${this.index + 1} of ${this.total}`),
      element('span', 'cm-changePeek__what', describeChange(change)),
      button(
        'Revert',
        'Put these lines back the way they are stored (Ctrl+Alt+Z)',
        () => revertPeekedChange(view),
        'cm-changePeek__btn--revert'
      ),
      iconButton('<path d="m15 18-6-6 6-6"/>', 'Previous change (Shift+Alt+F5)', () =>
        previousChange(view)
      ),
      iconButton('<path d="m9 18 6-6-6-6"/>', 'Next change (Alt+F5)', () => nextChange(view)),
      iconButton(
        '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        'Close (Escape)',
        () => closePeek(view),
        'cm-changePeek__btn--close'
      )
    )
    root.append(head)

    const was = this.stored.slice(change.fromA, change.toA)
    const body = element('div', 'cm-changePeek__body')
    if (was.length === 0) {
      body.append(
        element(
          'div',
          'cm-changePeek__note',
          'Not in the stored definition — reverting takes these lines out.'
        )
      )
    } else {
      body.append(element('div', 'cm-changePeek__label', 'Stored'))
      was.forEach((text, offset) => {
        const row = element('div', 'cm-changePeek__line')
        row.append(
          element('span', 'cm-changePeek__number', String(change.fromA + offset + 1)),
          // A zero-width space keeps an empty line a line tall.
          element('span', 'cm-changePeek__text', text === '' ? '​' : text)
        )
        body.append(row)
      })
    }
    root.append(body)
    return root
  }

  override ignoreEvent(): boolean {
    return true
  }
}

const peekedLine = Decoration.line({ class: 'cm-changePeeked' })

/**
 * The open peek, under the lines of its change — or, for a deletion, where the
 * lines were — with those lines picked out.
 *
 * Block widgets change the height of the document, so they have to come from
 * the state rather than from a view plugin.
 */
const peekDecorations = EditorView.decorations.compute([tracked], (state) => {
  const value = state.field(tracked)
  if (value.peek === null) return Decoration.none
  const { doc } = state
  const index = value.changes.findIndex((change) => markerPos(doc, change) === value.peek)
  if (index < 0) return Decoration.none

  const change = value.changes[index]
  const widget = new PeekWidget(change, value.stored, index, value.changes.length)
  const ranges = []
  for (let line = change.fromB; line < change.toB; line += 1) {
    ranges.push(peekedLine.range(doc.line(line + 1).from))
  }
  if (change.toB > change.fromB) {
    ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(doc.line(change.toB).to))
  } else if (change.fromB > 0) {
    ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(doc.line(change.fromB).to))
  } else {
    ranges.push(Decoration.widget({ widget, block: true, side: -1 }).range(0))
  }
  return Decoration.set(ranges, true)
})

// --- look -----------------------------------------------------------------------

/**
 * Green for lines that were added, amber for lines that changed, red for
 * where lines were taken out — the colours every source-control gutter uses,
 * drawn from the app's own success, warning and danger tokens so they follow
 * the theme.
 */
const changeTheme = EditorView.baseTheme({
  '.cm-changeGutter': { width: '9px' },
  '.cm-changeGutter .cm-gutterElement': { position: 'relative' },
  '.cm-changeMarked': { cursor: 'pointer' },
  '.cm-changeMark': {
    position: 'absolute',
    top: '0',
    bottom: '0',
    left: '3px',
    width: '3px'
  },
  '.cm-changeMarked:hover .cm-changeMark': { left: '2px', width: '5px' },
  '.cm-changeMark--added': { background: 'var(--success)' },
  '.cm-changeMark--modified': { background: 'var(--warning)' },
  '.cm-changeMark--deleted, .cm-changeMark--deleted-last': {
    width: '0',
    borderTop: '4px solid transparent',
    borderBottom: '4px solid transparent',
    borderLeft: '6px solid var(--danger)'
  },
  '.cm-changeMarked:hover .cm-changeMark--deleted, .cm-changeMarked:hover .cm-changeMark--deleted-last':
    { left: '3px', width: '0' },
  '.cm-changeMark--deleted': { top: '-4px', bottom: 'auto' },
  '.cm-changeMark--deleted-last': { top: 'auto', bottom: '-4px' },

  '.cm-changePeeked': {
    backgroundColor: 'color-mix(in srgb, var(--warning) 9%, transparent)'
  },

  '.cm-changePeek': {
    margin: '4px 16px 8px 4px',
    border: '1px solid var(--border-overlay)',
    borderRadius: '8px',
    backgroundColor: 'var(--bg-overlay)',
    boxShadow: 'var(--shadow-menu)',
    color: 'var(--text-primary)',
    overflow: 'hidden'
  },
  '.cm-changePeek--added': { borderLeft: '3px solid var(--success)' },
  '.cm-changePeek--modified': { borderLeft: '3px solid var(--warning)' },
  '.cm-changePeek--deleted': { borderLeft: '3px solid var(--danger)' },
  '.cm-changePeek__head': {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '6px 8px 6px 14px',
    borderBottom: '1px solid var(--border-subtle)',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    lineHeight: '20px'
  },
  '.cm-changePeek__count': {
    fontSize: '11px',
    fontWeight: '600',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-secondary)'
  },
  '.cm-changePeek__what': { color: 'var(--text-muted)', marginRight: '6px' },
  '.cm-changePeek__btn': {
    height: '24px',
    minWidth: '24px',
    padding: '0 9px',
    border: '1px solid var(--border-strong)',
    borderRadius: '6px',
    background: 'var(--bg-control)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    fontWeight: '500',
    cursor: 'pointer'
  },
  '.cm-changePeek__btn:hover': { backgroundColor: 'var(--bg-control-hover)' },
  '.cm-changePeek__btn--icon': {
    display: 'inline-grid',
    placeItems: 'center',
    width: '24px',
    padding: '0'
  },
  '.cm-changePeek__btn--revert': {
    borderColor: 'transparent',
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-text)',
    fontWeight: '600'
  },
  '.cm-changePeek__btn--revert:hover': {
    backgroundColor: 'var(--accent-hover)'
  },
  '.cm-changePeek__btn--close': {
    borderColor: 'transparent',
    background: 'transparent',
    color: 'var(--text-muted)'
  },
  '.cm-changePeek__btn--close:hover': {
    backgroundColor: 'var(--bg-hover-strong)',
    color: 'var(--text-primary)'
  },
  '.cm-changePeek__body': {
    maxHeight: '240px',
    overflow: 'auto',
    padding: '4px 0'
  },
  '.cm-changePeek__label': {
    padding: '2px 14px 4px',
    fontFamily: 'var(--font-ui)',
    fontSize: '11px',
    fontWeight: '600',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--danger)'
  },
  '.cm-changePeek__line': {
    display: 'flex',
    whiteSpace: 'pre',
    backgroundColor: 'color-mix(in srgb, var(--danger) 10%, transparent)'
  },
  '.cm-changePeek__number': {
    flex: '0 0 auto',
    width: '44px',
    paddingRight: '10px',
    textAlign: 'right',
    color: 'var(--text-dim)',
    userSelect: 'none'
  },
  '.cm-changePeek__text': { color: 'var(--text-secondary)', userSelect: 'text' },
  '.cm-changePeek__note': {
    padding: '2px 14px',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    color: 'var(--text-muted)'
  }
})

/**
 * Everything an editor needs to mark its changes against `stored`: the
 * gutter, the peek, and the keys — Alt+F5 and Shift+Alt+F5 to step through
 * the changes, Ctrl+Alt+Z to revert the one under the cursor, Escape to shut
 * the peek.
 */
export function changeTracking(stored: string): Extension {
  const lines = splitLines(stored)
  return [
    tracked.init((state) => ({
      stored: lines,
      changes: diffLines(lines, state.doc.toJSON()),
      peek: null
    })),
    changeGutter,
    peekDecorations,
    changeTheme,
    keymap.of([
      { key: 'Alt-F5', run: nextChange, preventDefault: true },
      { key: 'Shift-Alt-F5', run: previousChange, preventDefault: true },
      { key: 'Mod-Alt-z', run: revertChangeAtCursor, preventDefault: true },
      { key: 'Escape', run: closePeek }
    ])
  ]
}
