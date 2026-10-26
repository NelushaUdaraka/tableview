<script setup lang="ts">
/**
 * CodeMirror 6 SQL editor.
 *
 * Schema-aware completion is fed from the connected database, and the theme
 * lives in a compartment so switching light/dark does not rebuild the state
 * (which would lose undo history and the cursor).
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { MSSQL, sql } from '@codemirror/lang-sql'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view'
import {
  changeTracking,
  nextChange,
  previousChange,
  revertAllChanges,
  setBaseline,
  trackedChanges
} from '../lib/changeTracking'
import { matcherFor, type LineMatchOptions } from '@shared/sql/definitionSearch'

const props = withDefaults(
  defineProps<{
    modelValue: string
    schema?: Record<string, string[]>
    theme?: 'dark' | 'light'
    fontFamily?: string
    fontSize?: number
    placeholder?: string
    readonly?: boolean
    /**
     * The stored text this document is an edit of — a routine's definition.
     * Given one, the editor marks every line that differs from it and offers
     * to put each change back; null tracks nothing.
     */
    baseline?: string | null
  }>(),
  {
    schema: () => ({}),
    theme: 'dark',
    fontFamily: 'monospace',
    fontSize: 13,
    placeholder: '-- Write T-SQL here. Ctrl+Enter runs it.',
    readonly: false,
    baseline: null
  }
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'cursor', offset: number): void
  (event: 'run'): void
  (event: 'run-selection'): void
  (event: 'run-current'): void
  /** Ctrl+L and Ctrl+M, as in SSMS: the estimated plan, and a run with the actual one. */
  (event: 'plan', kind: 'estimated' | 'actual'): void
  (event: 'save'): void
  /** How many separate changes the document has against `baseline`. */
  (event: 'changes', count: number): void
}>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null

const themeCompartment = new Compartment()
const schemaCompartment = new Compartment()
const styleCompartment = new Compartment()
/** Empty unless there is a baseline, so a plain query tab has no change gutter at all. */
const changesCompartment = new Compartment()

function changesExtension(): Extension {
  return props.baseline === null ? [] : changeTracking(props.baseline)
}

/**
 * The fold marker, drawn as the same chevron the trees use rather than the
 * typed `⌄` and `›`, which came out in whatever font the platform had.
 */
function foldMarker(open: boolean): HTMLElement {
  const marker = document.createElement('span')
  marker.className = `cm-foldMarker${open ? ' cm-foldMarker--open' : ''}`
  marker.title = open ? 'Fold' : 'Unfold'
  marker.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m9 18 6-6-6-6"/></svg>'
  return marker
}

function baseTheme(): ReturnType<typeof EditorView.theme> {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: `${props.fontSize}px`,
        backgroundColor: 'var(--bg-surface)',
        color: 'var(--text-primary)'
      },
      '.cm-content': {
        fontFamily: props.fontFamily,
        caretColor: 'var(--accent)',
        userSelect: 'text',
        padding: '12px 0'
      },
      '.cm-scroller': { fontFamily: props.fontFamily, overflow: 'auto', lineHeight: '21px' },
      '.cm-line': { padding: '0 16px 0 12px' },
      // The gutter shares the editor's ground; the numbers are what set it off.
      '.cm-gutters': {
        backgroundColor: 'var(--bg-surface)',
        color: 'var(--text-dim)',
        border: 'none'
        // No vertical padding here: CodeMirror already offsets each gutter
        // row by the content's top padding, so padding the gutter as well
        // pushed every line number below the line it belongs to.
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 16px', minWidth: '48px' },
      '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--text-primary)'
      },
      '.cm-foldGutter .cm-gutterElement': { display: 'flex', alignItems: 'center' },
      '.cm-foldMarker': {
        display: 'grid',
        placeItems: 'center',
        width: '16px',
        height: '16px',
        borderRadius: '4px',
        color: 'var(--text-dim)',
        cursor: 'pointer'
      },
      '.cm-foldMarker:hover': { color: 'var(--text-primary)', backgroundColor: 'var(--bg-hover-strong)' },
      '.cm-foldMarker--open svg': { transform: 'rotate(90deg)' },
      '.cm-foldPlaceholder': {
        margin: '0 3px',
        padding: '0 5px',
        border: '1px solid var(--border-strong)',
        borderRadius: '4px',
        backgroundColor: 'var(--bg-raised)',
        color: 'var(--text-muted)'
      },
      '&.cm-focused .cm-matchingBracket': {
        backgroundColor: 'var(--accent-soft)',
        outline: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)',
        borderRadius: '2px'
      },
      '.cm-nonmatchingBracket': {
        backgroundColor: 'color-mix(in srgb, var(--danger) 18%, transparent)'
      },
      // The selection has to read on top of the active line, which is already
      // --bg-hover — so it gets the accent wash the rest of the app uses, and a
      // fainter one when the editor does not have focus.
      //
      // The focused rule spells out the whole path on purpose: CodeMirror's own
      // is `&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`,
      // and a shorter override loses to it on specificity however late it lands.
      '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection-idle)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
        backgroundColor: 'var(--selection)'
      },
      '&.cm-focused ::selection': { backgroundColor: 'var(--selection)' },
      // Other occurrences of the selected word: present, but not mistakable for
      // the selection itself.
      '.cm-selectionMatch': { backgroundColor: 'var(--bg-hover-strong)' },
      '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
      '.cm-tooltip': {
        backgroundColor: 'var(--bg-overlay)',
        border: '1px solid var(--border-overlay)',
        borderRadius: '8px',
        boxShadow: 'var(--shadow-menu)',
        color: 'var(--text-primary)',
        overflow: 'hidden'
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        padding: '4px',
        fontFamily: props.fontFamily,
        maxHeight: '18em'
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
        padding: '3px 8px',
        borderRadius: '5px',
        lineHeight: '20px'
      },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--accent-soft)',
        color: 'var(--text-primary)'
      },
      '.cm-completionIcon': { opacity: '0.7', paddingRight: '6px' },
      '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal', marginLeft: '8px' },
      '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent-fg)', fontWeight: '600' },
      // The find bar, in the window's own controls rather than the browser's.
      '.cm-panels': {
        backgroundColor: 'var(--bg-app)',
        color: 'var(--text-primary)'
      },
      '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border-subtle)' },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-subtle)' },
      '.cm-panel.cm-search': {
        padding: '8px 36px 8px 12px',
        fontFamily: 'var(--font-ui)',
        fontSize: '12px'
      },
      '.cm-panel.cm-search label': { fontSize: '12px', color: 'var(--text-secondary)' },
      '.cm-textfield': {
        height: '26px',
        padding: '0 8px',
        border: '1px solid var(--border-strong)',
        borderRadius: '6px',
        backgroundColor: 'var(--bg-input)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-ui)',
        fontSize: '12px',
        outline: 'none'
      },
      '.cm-textfield:focus': {
        borderColor: 'var(--accent)',
        boxShadow: '0 0 0 3px var(--accent-ring)'
      },
      '.cm-button': {
        height: '26px',
        padding: '0 10px',
        border: '1px solid var(--border-strong)',
        borderRadius: '6px',
        backgroundImage: 'none',
        backgroundColor: 'var(--bg-control)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-ui)',
        fontSize: '12px'
      },
      '.cm-button:hover': { backgroundColor: 'var(--bg-control-hover)' },
      '.cm-panel.cm-search [name=close]': {
        top: '8px',
        right: '10px',
        width: '22px',
        height: '22px',
        borderRadius: '5px',
        color: 'var(--text-muted)',
        fontSize: '16px'
      },
      '.cm-searchMatch': {
        backgroundColor: 'color-mix(in srgb, var(--warning) 24%, transparent)',
        outline: '1px solid color-mix(in srgb, var(--warning) 45%, transparent)'
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'color-mix(in srgb, var(--warning) 45%, transparent)'
      }
    },
    { dark: props.theme === 'dark' }
  )
}

function sqlExtension(): ReturnType<typeof sql> {
  return sql({
    dialect: MSSQL,
    schema: props.schema,
    upperCaseKeywords: true
  })
}

/**
 * SQL in the window's syntax palette (the --syntax-* tokens): keywords carry
 * the accent's own tint, so the editor still says which connection it is in,
 * and strings, numbers, functions and types each get a hue of their own —
 * tuned per theme in the stylesheet, so this table never has to know which
 * one is showing.
 */
const sqlHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--syntax-keyword)' },
  { tag: [tags.controlKeyword, tags.definitionKeyword], color: 'var(--syntax-keyword)' },
  { tag: [tags.function(tags.variableName), tags.standard(tags.name)], color: 'var(--syntax-function)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.variableName, tags.propertyName, tags.name], color: 'var(--text-primary)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syntax-type)' },
  { tag: tags.operator, color: 'var(--text-secondary)' },
  { tag: [tags.punctuation, tags.separator, tags.bracket], color: 'var(--text-muted)' },
  { tag: tags.invalid, color: 'var(--danger)' }
])

function themeExtension(): unknown[] {
  return [syntaxHighlighting(sqlHighlight, { fallback: true })]
}

onMounted(() => {
  if (!host.value) return

  const runKeymap = keymap.of([
    { key: 'Mod-Enter', preventDefault: true, run: () => (emit('run'), true) },
    { key: 'Mod-Shift-Enter', preventDefault: true, run: () => (emit('run-selection'), true) },
    { key: 'Mod-Alt-Enter', preventDefault: true, run: () => (emit('run-current'), true) },
    { key: 'Mod-s', preventDefault: true, run: () => (emit('save'), true) },
    // Ahead of the default keymap, whose Mod-l selects the line.
    { key: 'Mod-l', preventDefault: true, run: () => (emit('plan', 'estimated'), true) },
    { key: 'Mod-m', preventDefault: true, run: () => (emit('plan', 'actual'), true) }
  ])

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      // Between the line numbers and the fold markers, where an editor's
      // change bars usually sit.
      changesCompartment.of(changesExtension()),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      foldGutter({ markerDOM: foldMarker }),
      drawSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      autocompletion({ activateOnTyping: true, maxRenderedOptions: 40 }),
      placeholderExt(props.placeholder),
      // The run bindings come first so Mod-Enter is not consumed by defaults.
      runKeymap,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...searchKeymap,
        indentWithTab
      ]),
      schemaCompartment.of(sqlExtension()),
      themeCompartment.of(themeExtension() as never),
      styleCompartment.of(baseTheme()),
      EditorState.readOnly.of(props.readonly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit('update:modelValue', update.state.doc.toString())
        }
        if (update.selectionSet || update.docChanged) {
          emit('cursor', update.state.selection.main.head)
        }
        const count = trackedChanges(update.state).length
        if (count !== trackedChanges(update.startState).length) emit('changes', count)
      })
    ]
  })

  view = new EditorView({ state, parent: host.value })
  // A tab coming back on screen is a new editor over text that may already
  // differ from what is stored; no update reports that, so say it here.
  emit('changes', trackedChanges(view.state).length)
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

// Only push external changes back into the document; echoing our own edit
// would reset the cursor on every keystroke.
watch(
  () => props.modelValue,
  (next) => {
    if (!view) return
    const current = view.state.doc.toString()
    if (current === next) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: next } })
  }
)

watch(
  () => props.schema,
  () => {
    view?.dispatch({ effects: schemaCompartment.reconfigure(sqlExtension()) })
  },
  { deep: true }
)

watch(
  () => props.theme,
  () => {
    // The base theme carries the dark flag now, so it is rebuilt with the rest.
    view?.dispatch({
      effects: [
        themeCompartment.reconfigure(themeExtension() as never),
        styleCompartment.reconfigure(baseTheme())
      ]
    })
  }
)

watch([() => props.fontFamily, () => props.fontSize], () => {
  view?.dispatch({ effects: styleCompartment.reconfigure(baseTheme()) })
})

/**
 * A new baseline is the stored text moving — the tab's script has just been
 * written to the server — so the marks are measured afresh against it. Only
 * starting or stopping tracking needs the gutter itself added or taken away.
 */
watch(
  () => props.baseline,
  (next, previous) => {
    if (!view) return
    if ((next === null) !== (previous === null)) {
      view.dispatch({ effects: changesCompartment.reconfigure(changesExtension()) })
    } else if (next !== null) {
      view.dispatch({ effects: setBaseline.of(next) })
    }
  }
)

/** Runs a change command from outside the editor, then hands the keyboard back. */
function changeCommand(command: (target: EditorView) => boolean): void {
  if (!view) return
  command(view)
  view.focus()
}

function getSelection(): { from: number; to: number; text: string } {
  if (!view) return { from: 0, to: 0, text: '' }
  const range = view.state.selection.main
  return { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) }
}

function getCursor(): number {
  return view?.state.selection.main.head ?? 0
}

function focus(): void {
  view?.focus()
}

function insertText(text: string): void {
  if (!view) return
  const range = view.state.selection.main
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length }
  })
  view.focus()
}

/**
 * Scrolls a line (numbered from 1) to the middle and puts the cursor on it —
 * selecting `find` there when it is on that line, as a search result shows it.
 * A line past the end goes to the last: the text may have been edited since
 * the line was found.
 */
function revealLine(lineNumber: number, find?: LineMatchOptions & { text: string }): void {
  if (!view) return
  const doc = view.state.doc
  const line = doc.line(Math.min(Math.max(1, Math.floor(lineNumber)), doc.lines))
  let anchor = line.from
  let head = line.from
  const match = find?.text ? matcherFor(find.text, find).exec(line.text) : null
  if (match) {
    anchor = line.from + match.index
    head = anchor + match[0].length
  }
  view.dispatch({
    selection: { anchor, head },
    effects: EditorView.scrollIntoView(anchor, { y: 'center' })
  })
  view.focus()
}

function setValue(text: string): void {
  if (!view) return
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text }
  })
}

defineExpose({
  getSelection,
  getCursor,
  focus,
  insertText,
  setValue,
  revealLine,
  nextChange: () => changeCommand(nextChange),
  previousChange: () => changeCommand(previousChange),
  revertAllChanges: () => changeCommand(revertAllChanges)
})
</script>

<template>
  <div ref="host" class="editor"></div>
</template>

<style scoped>
.editor {
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-surface);
}
:deep(.cm-editor) {
  height: 100%;
}
:deep(.cm-editor.cm-focused) {
  outline: none;
}
</style>
