/**
 * The sidebar's Search panel: text found in the database's procedures,
 * functions, views and triggers, or the ones that use a given object.
 *
 * Both answer with the same list, so they share it: finding the references of
 * a table replaces a text search's results, and searching again replaces
 * those. Only the latest request's answer is kept — an older one arriving late
 * would show results for a question nobody is asking any more.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { MODULE_KINDS, type DefinitionSearchResult, type ModuleKind } from '@shared/types'
import { api } from '../lib/api'

/** What the list is the answer to. */
export type DefinitionQuestion =
  | { mode: 'text'; text: string; matchCase: boolean; wholeWord: boolean; database: string }
  | { mode: 'references'; schema: string; name: string; database: string }

export const useDefinitionSearchStore = defineStore('definitionSearch', () => {
  const text = ref('')
  const matchCase = ref(false)
  const wholeWord = ref(false)
  const kinds = ref<ModuleKind[]>([...MODULE_KINDS])

  const question = ref<DefinitionQuestion | null>(null)
  const result = ref<DefinitionSearchResult | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let latest = 0

  /** Matches across every object, for the summary line. */
  const lineCount = computed(
    () =>
      result.value?.matches.reduce((sum, match) => sum + match.lines.length + match.moreLines, 0) ??
      0
  )

  async function ask(
    next: DefinitionQuestion,
    read: () => Promise<DefinitionSearchResult>
  ): Promise<void> {
    const token = ++latest
    question.value = next
    result.value = null
    error.value = null
    loading.value = true
    try {
      const answer = await read()
      if (token === latest) result.value = answer
    } catch (failure) {
      if (token === latest) error.value = (failure as Error)?.message ?? String(failure)
    } finally {
      if (token === latest) loading.value = false
    }
  }

  /** Searches for the text in the box, with the options as they are set. */
  async function search(connectionId: string, database: string): Promise<void> {
    const find = text.value.trim()
    if (!find) {
      clear()
      return
    }
    // With every kind switched off the main process searches them all.
    const request = {
      connectionId,
      text: find,
      matchCase: matchCase.value,
      wholeWord: wholeWord.value,
      kinds: [...kinds.value]
    }
    await ask({ mode: 'text', text: find, matchCase: request.matchCase, wholeWord: request.wholeWord, database }, () =>
      api.searchDefinitions(request)
    )
  }

  /** Lists what uses `schema.name`. */
  async function findReferences(
    connectionId: string,
    database: string,
    schema: string,
    name: string
  ): Promise<void> {
    await ask({ mode: 'references', schema, name, database }, () =>
      api.findReferences(connectionId, schema, name)
    )
  }

  function toggleKind(kind: ModuleKind): void {
    kinds.value = kinds.value.includes(kind)
      ? kinds.value.filter((entry) => entry !== kind)
      : MODULE_KINDS.filter((entry) => entry === kind || kinds.value.includes(entry))
  }

  /** Forgets the results; the box and its options stay as they were set. */
  function clear(): void {
    latest += 1
    question.value = null
    result.value = null
    error.value = null
    loading.value = false
  }

  return {
    text,
    matchCase,
    wholeWord,
    kinds,
    question,
    result,
    loading,
    error,
    lineCount,
    search,
    findReferences,
    toggleKind,
    clear
  }
})
