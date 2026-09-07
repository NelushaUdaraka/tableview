import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ConnectionConfig, ConnectionStatus, SavedConnection } from '@shared/types'
import { api } from '../lib/api'

export const useConnectionStore = defineStore('connections', () => {
  const saved = ref<SavedConnection[]>([])
  const statuses = ref<Record<string, ConnectionStatus>>({})
  const activeId = ref<string | null>(null)
  const connectingId = ref<string | null>(null)

  const active = computed(() => saved.value.find((entry) => entry.id === activeId.value) ?? null)
  const activeStatus = computed<ConnectionStatus | null>(() =>
    activeId.value ? (statuses.value[activeId.value] ?? null) : null
  )
  const isConnected = computed(() => activeStatus.value?.state === 'connected')

  /** Most-recently-used first, then alphabetical for never-used entries. */
  const sorted = computed(() =>
    [...saved.value].sort((a, b) => {
      if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt)
      if (a.lastUsedAt) return -1
      if (b.lastUsedAt) return 1
      return a.name.localeCompare(b.name)
    })
  )

  async function load(): Promise<void> {
    saved.value = await api.listConnections()
  }

  async function save(
    input: Partial<ConnectionConfig> & { name: string }
  ): Promise<SavedConnection> {
    const record = await api.saveConnection(input)
    await load()
    return record
  }

  async function remove(id: string): Promise<void> {
    await api.deleteConnection(id)
    if (activeId.value === id) activeId.value = null
    delete statuses.value[id]
    await load()
  }

  async function duplicate(id: string): Promise<void> {
    await api.duplicateConnection(id)
    await load()
  }

  async function connect(id: string, password?: string): Promise<ConnectionStatus> {
    connectingId.value = id
    statuses.value = { ...statuses.value, [id]: { connectionId: id, state: 'connecting' } }
    try {
      const status = await api.connect(id, password)
      statuses.value = { ...statuses.value, [id]: status }
      if (status.state === 'connected') activeId.value = id
      await load()
      return status
    } catch (error) {
      const status: ConnectionStatus = {
        connectionId: id,
        state: 'error',
        error: { message: error instanceof Error ? error.message : String(error) }
      }
      statuses.value = { ...statuses.value, [id]: status }
      return status
    } finally {
      connectingId.value = null
    }
  }

  async function disconnect(id: string): Promise<void> {
    await api.disconnect(id)
    statuses.value = { ...statuses.value, [id]: { connectionId: id, state: 'disconnected' } }
    if (activeId.value === id) activeId.value = null
  }

  function setStatus(status: ConnectionStatus): void {
    statuses.value = { ...statuses.value, [status.connectionId]: status }
  }

  function statusFor(id: string): ConnectionStatus {
    return statuses.value[id] ?? { connectionId: id, state: 'disconnected' }
  }

  return {
    saved,
    sorted,
    statuses,
    activeId,
    active,
    activeStatus,
    isConnected,
    connectingId,
    load,
    save,
    remove,
    duplicate,
    connect,
    disconnect,
    setStatus,
    statusFor
  }
})
