<script setup lang="ts">
/**
 * CodeMirror 6 SQL editor.
 *
 * Schema-aware completion is fed from the connected database, and the theme
 * lives in a compartment so switching light/dark does not rebuild the state
 * (which would lose undo history and the cursor).
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
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

const props = withDefaults(
  defineProps<{
    modelValue: string
    schema?: Record<string, string[]>
    theme?: 'dark' | 'light'
    fontFamily?: string
    fontSize?: number
    placeholder?: string
    readonly?: boolean
  }>(),
  {
    schema: () => ({}),
    theme: 'dark',
    fontFamily: 'monospace',
    fontSize: 13,
    placeholder: '-- Write T-SQL here. Ctrl+Enter runs it.',
    readonly: false
  }
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'cursor', offset: number): void
  (event: 'run'): void
  (event: 'run-selection'): void
  (event: 'run-current'): void
  (event: 'save'): void
}>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null

const themeCompartment = new Compartment()
const schemaCompartment = new Compartment()
const styleCompartment = new Compartment()

function baseTheme(): ReturnType<typeof EditorView.theme> {
  return EditorView.theme({
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
      padding: '10px 0'
    },
    '.cm-scroller': { fontFamily: props.fontFamily, overflow: 'auto', lineHeight: '20px' },
    '.cm-line': { padding: '0 14px' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-app)',
      color: 'var(--text-dim)',
      border: 'none',
      borderRight: '1px solid var(--border-subtle)',
      padding: '10px 0'
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 20px', minWidth: '52px' },
    '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--bg-selected)'
    },
    '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-tooltip': {
      backgroundColor: 'var(--bg-surface)',
      border: '1px solid var(--border-strong)',
      borderRadius: '0',
      boxShadow: 'var(--shadow-menu)',
      color: 'var(--text-primary)'
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--bg-selected)',
      color: 'var(--text-primary)'
    }
  })
}

function sqlExtension(): ReturnType<typeof sql> {
  return sql({
    dialect: MSSQL,
    schema: props.schema,
    upperCaseKeywords: true
  })
}

/**
 * SQL in the Modernist palette: keywords carry the accent, the values they act
 * on drop back to the secondary ramp, and everything else is plain ink. There
 * is no second hue — the system is mono by design.
 */
const modernistHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--accent-bright)' },
  { tag: [tags.controlKeyword, tags.definitionKeyword], color: 'var(--accent-bright)' },
  { tag: [tags.function(tags.variableName), tags.standard(tags.name)], color: 'var(--text-primary)', fontWeight: '500' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--text-secondary)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--text-secondary)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--text-dim)', fontStyle: 'italic' },
  { tag: [tags.variableName, tags.propertyName, tags.name], color: 'var(--text-primary)' },
  { tag: [tags.typeName, tags.className], color: 'var(--text-primary)' },
  { tag: tags.operator, color: 'var(--text-secondary)' },
  { tag: [tags.punctuation, tags.separator, tags.bracket], color: 'var(--text-muted)' },
  { tag: tags.invalid, color: 'var(--danger)' }
])

function themeExtension(): unknown[] {
  return [syntaxHighlighting(modernistHighlight, { fallback: true })]
}

onMounted(() => {
  if (!host.value) return

  const runKeymap = keymap.of([
    { key: 'Mod-Enter', preventDefault: true, run: () => (emit('run'), true) },
    { key: 'Mod-Shift-Enter', preventDefault: true, run: () => (emit('run-selection'), true) },
    { key: 'Mod-Alt-Enter', preventDefault: true, run: () => (emit('run-current'), true) },
    { key: 'Mod-s', preventDefault: true, run: () => (emit('save'), true) }
  ])

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      foldGutter(),
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
      })
    ]
  })

  view = new EditorView({ state, parent: host.value })
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
    view?.dispatch({ effects: themeCompartment.reconfigure(themeExtension() as never) })
  }
)

watch([() => props.fontFamily, () => props.fontSize], () => {
  view?.dispatch({ effects: styleCompartment.reconfigure(baseTheme()) })
})

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

function setValue(text: string): void {
  if (!view) return
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text }
  })
}

defineExpose({ getSelection, getCursor, focus, insertText, setValue })
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
/* Square selections and no rounded autocomplete card. */
:deep(.cm-tooltip-autocomplete ul li) {
  border-radius: 0;
}
:deep(.cm-panels) {
  background: var(--bg-app);
  border-color: var(--border-strong);
  color: var(--text-primary);
}
</style>
