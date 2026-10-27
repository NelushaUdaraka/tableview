/**
 * The snippet list the editor's completion offers, and the dialog edits.
 *
 * The main process owns `snippets.json`; this holds the window's copy, read
 * when the workspace opens and again whenever the window gets the focus, so
 * an edit made in one window reaches the others without a broadcast.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Snippet } from '@shared/types'
import type { SnippetImportSummary } from '@shared/snippets'
import { api } from '../lib/api'

export const useSnippetStore = defineStore('snippets', () => {
  const snippets = ref<Snippet[]>([])

  async function load(): Promise<void> {
    snippets.value = await api.listSnippets()
  }

  /** Saves the whole list; throws, keeping the old one, when one is not valid. */
  async function save(next: Snippet[]): Promise<void> {
    snippets.value = await api.saveSnippets(next)
  }

  function exportFile(): Promise<{ filePath: string; count: number } | null> {
    return api.exportSnippets()
  }

  async function importFile(): Promise<SnippetImportSummary | null> {
    const result = await api.importSnippets()
    if (!result) return null
    snippets.value = result.snippets
    return result.summary
  }

  return { snippets, load, save, exportFile, importFile }
})
