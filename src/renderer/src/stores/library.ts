import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { QueryHistoryEntry, SavedQuery } from '@shared/types'
import { api } from '../lib/api'

export const useLibraryStore = defineStore('library', () => {
  const history = ref<QueryHistoryEntry[]>([])
  const savedQueries = ref<SavedQuery[]>([])
  const historySearch = ref('')

  async function loadHistory(): Promise<void> {
    history.value = await api.listHistory(historySearch.value || undefined)
  }

  async function clearHistory(): Promise<void> {
    await api.clearHistory()
    history.value = []
  }

  async function loadSavedQueries(): Promise<void> {
    savedQueries.value = await api.listSavedQueries()
  }

  async function saveQuery(
    input: Partial<SavedQuery> & { name: string; sql: string }
  ): Promise<SavedQuery> {
    const record = await api.saveQuery(input)
    await loadSavedQueries()
    return record
  }

  async function deleteSavedQuery(id: string): Promise<void> {
    await api.deleteSavedQuery(id)
    await loadSavedQueries()
  }

  return {
    history,
    savedQueries,
    historySearch,
    loadHistory,
    clearHistory,
    loadSavedQueries,
    saveQuery,
    deleteSavedQuery
  }
})
