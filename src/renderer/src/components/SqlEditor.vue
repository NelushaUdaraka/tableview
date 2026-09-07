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
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import { lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'

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
      userSelect: 'text'
    },
    '.cm-scroller': { fontFamily: props.fontFamily, overflow: 'auto' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-raised)',
      color: 'var(--text-muted)',
      border: 'none',
      borderRight: '1px solid var(--border)'
    },
    '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--bg-selected)'
    },
    '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-tooltip': {
      backgroundColor: 'var(--bg-overlay)',
      border: '1px solid var(--border-strong)',
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

function themeExtension(): unknown[] {
  return props.theme === 'dark'
    ? [oneDark]
    : [syntaxHighlighting(defaultHighlightStyle, { fallback: true })]
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
}
:deep(.cm-editor) {
  height: 100%;
}
:deep(.cm-editor.cm-focused) {
  outline: none;
}
</style>
