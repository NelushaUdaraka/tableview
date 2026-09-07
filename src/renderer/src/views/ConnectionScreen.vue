<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ConnectionConfig, SavedConnection } from '@shared/types'
import BaseModal from '../components/BaseModal.vue'
import ConnectionForm from '../components/ConnectionForm.vue'
import ContextMenu, { type MenuEntry } from '../components/ContextMenu.vue'
import { useConnectionStore } from '../stores/connections'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toasts'
import { onMenuAction } from '../lib/menuBus'
import { api } from '../lib/api'

const connections = useConnectionStore()
const settings = useSettingsStore()
const toasts = useToastStore()

const editing = ref<SavedConnection | null>(null)
const showForm = ref(false)
const testing = ref(false)
const search = ref('')
const menu = ref<{ x: number; y: number; connection: SavedConnection } | null>(null)
const passwordPrompt = ref<{ connection: SavedConnection; value: string } | null>(null)

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase()
  if (!needle) return connections.sorted
  return connections.sorted.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) ||
      entry.host.toLowerCase().includes(needle) ||
      (entry.database ?? '').toLowerCase().includes(needle)
  )
})

let unsubscribeMenu: (() => void) | null = null

onMounted(() => {
  void connections.load()
  // File → New Connection has nowhere else to land while this screen is up.
  unsubscribeMenu = onMenuAction((action) => {
    if (action === 'connection:new') startNew()
  })
})

onBeforeUnmount(() => unsubscribeMenu?.())

function startNew(): void {
  editing.value = null
  showForm.value = true
}

function startEdit(connection: SavedConnection): void {
  editing.value = connection
  showForm.value = true
}

async function save(input: Partial<ConnectionConfig> & { name: string }): Promise<void> {
  try {
    await connections.save(input)
    showForm.value = false
    toasts.success('Connection saved')
  } catch (error) {
    toasts.fromError('Could not save the connection', error)
  }
}

async function test(input: Partial<ConnectionConfig>): Promise<void> {
  testing.value = true
  try {
    const status = await api.testConnection(input)
    if (status.state === 'connected') {
      toasts.success(
        'Connection succeeded',
        `${status.serverEdition ?? ''} ${status.serverVersion ?? ''}`.trim()
      )
    } else {
      toasts.error('Connection failed', status.error?.message)
    }
  } catch (error) {
    toasts.fromError('Connection failed', error)
  } finally {
    testing.value = false
  }
}

/** Connects, prompting for a password when none is stored. */
async function open(connection: SavedConnection, password?: string): Promise<void> {
  const needsPassword =
    connection.authType !== 'windows' && !connection.hasSavedPassword && password === undefined
  if (needsPassword) {
    passwordPrompt.value = { connection, value: '' }
    return
  }

  const status = await connections.connect(connection.id, password)
  if (status.state === 'error') {
    toasts.error(`Could not connect to ${connection.name}`, status.error?.message)
  } else {
    passwordPrompt.value = null
  }
}

async function remove(connection: SavedConnection): Promise<void> {
  if (!confirm(`Delete the connection “${connection.name}”? This cannot be undone.`)) return
  await connections.remove(connection.id)
  toasts.info('Connection deleted')
}

const menuItems: MenuEntry[] = [
  { label: 'Connect', action: 'connect' },
  { label: 'Edit…', action: 'edit' },
  { label: 'Duplicate', action: 'duplicate' },
  { separator: true, label: '' },
  { label: 'Delete', action: 'delete', danger: true }
]

async function onMenuSelect(action: string): Promise<void> {
  const connection = menu.value?.connection
  if (!connection) return
  if (action === 'connect') await open(connection)
  else if (action === 'edit') startEdit(connection)
  else if (action === 'duplicate') await connections.duplicate(connection.id)
  else if (action === 'delete') await remove(connection)
}

function subtitle(connection: SavedConnection): string {
  const parts = [`${connection.host}:${connection.port}`]
  if (connection.database) parts.push(connection.database)
  // Say how the connection gets there — it is the detail people scan for.
  if (connection.ssm?.enabled) parts.push(`via SSM ${connection.ssm.instanceId || '(no instance)'}`)
  else if (connection.ssh?.enabled) parts.push(`via ${connection.ssh.host}`)
  return parts.join(' · ')
}

function transportBadge(connection: SavedConnection): string | null {
  if (connection.ssm?.enabled) return 'SSM'
  if (connection.ssh?.enabled) return 'SSH'
  return null
}

function relativeTime(iso?: string): string {
  if (!iso) return 'never opened'
  const delta = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(delta / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString()
}
</script>

<template>
  <div class="screen">
    <header class="screen__head">
      <div class="brand">
        <svg class="brand__mark" viewBox="0 0 48 48" aria-hidden="true">
          <rect x="1" y="1" width="46" height="46" rx="11" fill="var(--bg-raised)" />
          <path
            d="M15 12h18l9 12-9 12H15L6 24z"
            fill="var(--accent)"
          />
          <path d="M8.5 20h31M6.5 24h35M8.5 28h31" stroke="var(--bg-app)" stroke-width="3" />
        </svg>
        <div>
          <h1 class="brand__title">Beekeeper Clone</h1>
          <p class="brand__sub">SQL Server client</p>
        </div>
      </div>
      <div class="screen__actions">
        <button class="btn btn--ghost btn--icon" title="Toggle theme" @click="settings.toggleTheme()">
          {{ settings.resolvedTheme === 'dark' ? '☀' : '☾' }}
        </button>
        <button class="btn btn--primary" @click="startNew">New connection</button>
      </div>
    </header>

    <div class="screen__body">
      <input
        v-model="search"
        class="input screen__search"
        placeholder="Search connections…"
        spellcheck="false"
      />

      <div v-if="filtered.length === 0" class="empty-state">
        <div class="empty-state__title">
          {{ connections.saved.length === 0 ? 'No saved connections yet' : 'No matches' }}
        </div>
        <p v-if="connections.saved.length === 0">
          Create one to get started — host, login, and an optional SSH tunnel.
        </p>
        <button v-if="connections.saved.length === 0" class="btn btn--primary" @click="startNew">
          New connection
        </button>
      </div>

      <ul v-else class="list">
        <li
          v-for="connection in filtered"
          :key="connection.id"
          class="card"
          :class="{ 'card--busy': connections.connectingId === connection.id }"
          @dblclick="open(connection)"
          @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, connection }"
        >
          <span
            class="card__stripe"
            :style="{ background: connection.color || 'var(--border-strong)' }"
          ></span>
          <div class="card__main">
            <div class="card__title truncate">{{ connection.name }}</div>
            <div class="card__sub truncate mono">{{ subtitle(connection) }}</div>
          </div>
          <div class="card__meta">
            <span v-if="transportBadge(connection)" class="badge">
              {{ transportBadge(connection) }}
            </span>
            <span class="badge">{{ connection.authType === 'windows' ? 'NTLM' : 'SQL' }}</span>
            <span class="card__time">{{ relativeTime(connection.lastUsedAt) }}</span>
          </div>
          <div class="card__buttons">
            <button class="btn btn--sm" @click.stop="startEdit(connection)">Edit</button>
            <button
              class="btn btn--sm btn--primary"
              :disabled="connections.connectingId === connection.id"
              @click.stop="open(connection)"
            >
              <span v-if="connections.connectingId === connection.id" class="spinner"></span>
              Connect
            </button>
          </div>
        </li>
      </ul>
    </div>

    <footer class="screen__foot muted">
      <span v-if="settings.appInfo">
        v{{ settings.appInfo.version }} · Electron {{ settings.appInfo.electronVersion }} ·
        {{
          settings.appInfo.secretsAreOsBacked
            ? 'secrets in the OS keystore'
            : 'secrets encrypted with a local key file'
        }}
      </span>
    </footer>

    <BaseModal
      v-if="showForm"
      :title="editing ? 'Edit connection' : 'New connection'"
      width="680px"
      @close="showForm = false"
    >
      <ConnectionForm
        :connection="editing"
        :busy="testing"
        @save="save"
        @test="test"
        @cancel="showForm = false"
      />
    </BaseModal>

    <BaseModal
      v-if="passwordPrompt"
      :title="`Password for ${passwordPrompt.connection.name}`"
      :subtitle="passwordPrompt.connection.username"
      width="400px"
      @close="passwordPrompt = null"
    >
      <form @submit.prevent="open(passwordPrompt!.connection, passwordPrompt!.value)">
        <label class="field">
          <span class="field__label">Password</span>
          <!-- eslint-disable-next-line vuejs-accessibility/no-autofocus -->
          <input
            v-model="passwordPrompt.value"
            class="input"
            type="password"
            autofocus
            autocomplete="current-password"
          />
        </label>
      </form>
      <template #footer>
        <button class="btn" @click="passwordPrompt = null">Cancel</button>
        <button
          class="btn btn--primary"
          @click="open(passwordPrompt!.connection, passwordPrompt!.value)"
        >
          Connect
        </button>
      </template>
    </BaseModal>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @select="onMenuSelect"
      @close="menu = null"
    />
  </div>
</template>

<style scoped>
.screen {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
}
.screen__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px;
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.brand__mark {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
}
.brand__title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}
.brand__sub {
  margin: 1px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
.screen__actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.screen__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px 24px;
  overflow: auto;
  max-width: 940px;
  width: 100%;
  margin: 0 auto;
}
.screen__search {
  flex: 0 0 auto;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 14px 11px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-surface);
  cursor: pointer;
  overflow: hidden;
  transition: border-color var(--transition), background var(--transition);
}
.card:hover {
  border-color: var(--border-strong);
  background: var(--bg-raised);
}
.card--busy {
  opacity: 0.75;
}
.card__stripe {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
}
.card__main {
  flex: 1;
  min-width: 0;
}
.card__title {
  font-weight: 600;
}
.card__sub {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}
.card__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.card__time {
  font-size: 11px;
  color: var(--text-muted);
  min-width: 74px;
  text-align: right;
}
.card__buttons {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}
.screen__foot {
  padding: 8px 24px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  text-align: center;
}
</style>
