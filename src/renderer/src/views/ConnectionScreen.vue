<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ConnectionConfig, SavedConnection } from '@shared/types'
import BaseModal from '../components/BaseModal.vue'
import ConnectionForm from '../components/ConnectionForm.vue'
import ContextMenu, { type MenuEntry } from '../components/ContextMenu.vue'
import { useConnectionStore } from '../stores/connections'
import { useCredentialsStore } from '../stores/credentials'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toasts'
import { onMenuAction } from '../lib/menuBus'
import { api } from '../lib/api'

const connections = useConnectionStore()
const credentials = useCredentialsStore()
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
    } else if (!credentials.offerRefresh(editing.value, status.error, () => test(input))) {
      toasts.error('Connection failed', status.error?.message)
    }
  } catch (error) {
    if (!credentials.offerRefresh(editing.value, error, () => test(input))) {
      toasts.fromError('Connection failed', error)
    }
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
    // Expiry is the one connection failure with a fix worth offering in place.
    const offered = credentials.offerRefresh(connection, status.error, () =>
      open(connection, password)
    )
    if (!offered) toasts.error(`Could not connect to ${connection.name}`, status.error?.message)
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

function endpoint(connection: SavedConnection): string {
  return `${connection.host}:${connection.port}`
}

/** How the connection gets there — the detail people scan for. */
function route(connection: SavedConnection): string {
  if (connection.ssm?.enabled) return `via SSM ${connection.ssm.instanceId || '(no instance)'}`
  if (connection.ssh?.enabled) return `via ${connection.ssh.host}`
  return 'direct'
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
          <path d="M15 6h18l9 18-9 18H15L6 24z" fill="currentColor" />
          <path d="M7 19h34M5 24h38M7 29h34" stroke="var(--bg-surface)" stroke-width="3.4" />
        </svg>
        <div class="brand__text">
          <h1 class="brand__title">Beekeeper Clone</h1>
          <p class="brand__sub">
            SQL Server client · {{ connections.saved.length }} saved
            {{ connections.saved.length === 1 ? 'connection' : 'connections' }}
          </p>
        </div>
      </div>
      <div class="screen__actions">
        <button class="screen__theme" title="Toggle theme" @click="settings.toggleTheme()">
          {{ settings.resolvedTheme === 'dark' ? '☀' : '☾' }}
        </button>
        <button class="btn btn--lg btn--primary" @click="startNew">New connection</button>
      </div>
    </header>

    <div class="screen__body">
      <div class="screen__search">
        <span class="screen__search-glyph">⌕</span>
        <input
          v-model="search"
          class="screen__search-input"
          placeholder="Search connections…"
          spellcheck="false"
        />
      </div>

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

      <div v-else class="table">
        <div class="table__head">
          <div></div>
          <div class="table__cell table__cell--wide">Name</div>
          <div class="table__cell table__cell--wide">Endpoint</div>
          <div class="table__cell">Transport</div>
          <div class="table__cell">Auth</div>
          <div class="table__cell table__cell--right">Last opened</div>
          <div></div>
        </div>

        <div class="table__body">
          <div
            v-for="connection in filtered"
            :key="connection.id"
            class="row"
            :class="{ 'row--busy': connections.connectingId === connection.id }"
            @dblclick="open(connection)"
            @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, connection }"
          >
            <span
              class="row__stripe"
              :style="{ background: connection.color || 'var(--text-muted)' }"
            ></span>

            <div class="row__cell row__cell--wide">
              <div class="row__name truncate">{{ connection.name }}</div>
              <div class="row__sub mono truncate">{{ connection.database || 'master' }}</div>
            </div>

            <div class="row__cell row__cell--wide">
              <div class="row__endpoint mono truncate">{{ endpoint(connection) }}</div>
              <div class="row__sub mono truncate">{{ route(connection) }}</div>
            </div>

            <div class="row__cell">
              <span v-if="transportBadge(connection)" class="badge badge--accent">
                {{ transportBadge(connection) }}
              </span>
            </div>

            <div class="row__cell">
              <span class="badge">{{ connection.authType === 'windows' ? 'NTLM' : 'SQL' }}</span>
            </div>

            <div class="row__cell row__cell--right row__time mono">
              {{ relativeTime(connection.lastUsedAt) }}
            </div>

            <div class="row__buttons">
              <button class="btn btn--sm btn--muted" @click.stop="startEdit(connection)">
                Edit
              </button>
              <button
                class="btn btn--sm btn--primary"
                :disabled="connections.connectingId === connection.id"
                @click.stop="open(connection)"
              >
                <span v-if="connections.connectingId === connection.id" class="spinner"></span>
                Connect
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <footer class="screen__foot muted">
      <template v-if="settings.appInfo">
        <span>v{{ settings.appInfo.version }}</span>
        <span class="screen__foot-sep">/</span>
        <span>Electron {{ settings.appInfo.electronVersion }}</span>
        <span class="screen__foot-sep">/</span>
        <span>
          {{
            settings.appInfo.secretsAreOsBacked
              ? 'secrets in the OS keystore'
              : 'secrets encrypted with a local key file'
          }}
        </span>
      </template>
    </footer>

    <BaseModal
      v-if="showForm"
      :kicker="editing ? 'Edit connection' : 'New connection'"
      :title="editing?.name || 'Untitled connection'"
      width="720px"
      flush
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
/* The seven tracks the header and every row share. */
.screen {
  --conn-cols: 6px minmax(0, 1.5fr) minmax(0, 2fr) 92px 92px 116px 168px;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
}
.screen__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 32px;
  padding: 28px 32px 22px;
  border-bottom: var(--rule) solid var(--border-strong);
  background: var(--bg-surface);
  flex: 0 0 auto;
}
.brand {
  display: flex;
  align-items: center;
  gap: 18px;
  min-width: 0;
}
.brand__mark {
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  color: var(--accent);
}
.brand__text {
  min-width: 0;
}
.brand__title {
  margin: 0;
  font-size: 28px;
  font-weight: 800;
  line-height: 1.05;
  letter-spacing: -0.02em;
}
.brand__sub {
  margin: 4px 0 0;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.screen__actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex: 0 0 auto;
}
.screen__theme {
  width: var(--h-field);
  height: var(--h-field);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-secondary);
  font-size: 15px;
  cursor: pointer;
}
.screen__theme:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.screen__head .btn--primary {
  height: var(--h-field);
  font-size: 14px;
}

.screen__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 24px 32px;
  overflow: hidden;
}
.screen__search {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  max-width: 420px;
  flex: 0 0 auto;
}
.screen__search:focus-within {
  border-color: var(--accent);
}
.screen__search-glyph {
  font-size: 13px;
  color: var(--text-muted);
}
.screen__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  user-select: text;
}
.screen__search-input::placeholder {
  color: var(--text-muted);
}

/* --- the connection table -------------------------------------------------- */
.table {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.table__head {
  display: grid;
  grid-template-columns: var(--conn-cols);
  align-items: center;
  height: 34px;
  margin-top: 20px;
  border-bottom: var(--rule) solid var(--border-strong);
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.table__cell {
  padding: 0 8px;
}
.table__cell--wide {
  padding: 0 14px;
}
.table__cell--right {
  text-align: right;
}
.table__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.row {
  display: grid;
  grid-template-columns: var(--conn-cols);
  align-items: center;
  height: 60px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.row:hover {
  background: var(--bg-hover);
}
.row--busy {
  opacity: 0.75;
}
/* The colour tag runs the full height of the row's leading edge. */
.row__stripe {
  align-self: stretch;
}
.row__cell {
  padding: 0 8px;
  min-width: 0;
}
.row__cell--wide {
  padding: 0 14px;
}
.row__cell--right {
  text-align: right;
}
.row__name {
  font-size: 15px;
  font-weight: 600;
}
.row__endpoint {
  font-size: 12px;
  color: var(--text-secondary);
}
.row__sub {
  font-size: 10px;
  color: var(--text-dim);
  margin-top: 2px;
}
.row__time {
  font-size: 11px;
  color: var(--text-muted);
}
.row__buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 0 4px 0 8px;
}
.row__buttons .btn {
  height: 30px;
}

.screen__foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: var(--h-statusbar);
  padding: 0 32px;
  border-top: var(--rule) solid var(--border-strong);
  background: var(--bg-raised);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  flex: 0 0 auto;
}
.screen__foot-sep {
  color: var(--border-strong);
}
</style>
