<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { useConnectionStore } from '../stores/connections'
import { useReadOnlyStore } from '../stores/readOnly'
import { useSchemaStore } from '../stores/schema'
import { useTabStore } from '../stores/tabs'

const emit = defineEmits<{
  (event: 'disconnect'): void
  (event: 'reconnect'): void
  (event: 'settings'): void
  (event: 'shortcuts'): void
}>()

const connections = useConnectionStore()
const readOnly = useReadOnlyStore()
const schema = useSchemaStore()
const tabs = useTabStore()

const status = computed(() => connections.activeStatus)
const stateLabel = computed(() => {
  switch (status.value?.state) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      // A session that is already open and is connecting again is a connection
      // being put back, which is worth saying in those words.
      return connections.inSession ? 'Reconnecting…' : 'Connecting…'
    case 'error':
      return 'Error'
    default:
      return 'Disconnected'
  }
})

/** Why the connection went, when the main process said. */
const stateDetail = computed(() => status.value?.error?.message ?? '')

/** Offered once a session's connection is down and staying down. */
const canReconnect = computed(
  () =>
    connections.inSession &&
    (status.value?.state === 'disconnected' || status.value?.state === 'error')
)

/**
 * Flips the open connection's read-only. Turning it on happens at once;
 * turning it off asks first, the same question every toggle asks.
 */
function toggleReadOnly(): void {
  const connection = connections.active
  if (connection) void readOnly.setReadOnly(connection, !connections.readOnly)
}

/** Where the cursor sits in the active query tab, pushed here by QueryView. */
const statementLine = computed(() =>
  tabs.active?.kind === 'query' ? tabs.active.statementLine : null
)

/** Which transport the active connection is tunnelled over. */
const transport = computed(() => (connections.active?.ssm?.enabled ? 'SSM' : 'SSH'))

const version = computed(() => {
  const info = status.value
  if (!info?.serverVersion) return ''
  const major = Number(info.serverVersion.split('.')[0])
  const names: Record<number, string> = {
    11: '2012',
    12: '2014',
    13: '2016',
    14: '2017',
    15: '2019',
    16: '2022',
    17: '2025'
  }
  return names[major] ? `SQL Server ${names[major]}` : `SQL Server ${info.serverVersion}`
})
</script>

<template>
  <footer class="status">
    <div class="status__seg status__seg--id">
      <span class="status__dot" :class="`status__dot--${status?.state ?? 'disconnected'}`"></span>
      <span class="status__name">{{ connections.active?.name ?? 'No connection' }}</span>
      <!-- When connected the dot and the segments carry the state; it is only
           spelled out when something needs saying. -->
      <span v-if="status?.state !== 'connected'" class="muted" :title="stateDetail">
        {{ stateLabel }}
      </span>
      <button v-if="canReconnect" class="status__retry" @click="emit('reconnect')">Reconnect</button>
    </div>

    <!-- The switch sits with the connection it belongs to, for the whole
         session, dropped or not: the connection is still the read-only one
         while it is being put back. Off, it is just the open padlock. -->
    <button
      v-if="connections.inSession && connections.active"
      class="status__seg status__lock"
      :class="{ 'status__lock--on': connections.readOnly }"
      aria-label="Read-only"
      :aria-pressed="connections.readOnly"
      :title="
        connections.readOnly
          ? 'Read-only: edits, truncate and drop are off, and statements that would change the database are refused. Click to turn it off.'
          : 'This connection can write. Click to make it read-only.'
      "
      @click="toggleReadOnly"
    >
      <AppIcon :name="connections.readOnly ? 'lock' : 'lock-open'" :size="12" />
      <span v-if="connections.readOnly">Read-only</span>
    </button>

    <template v-if="status?.state === 'connected'">
      <div class="status__seg status__seg--strong" title="Database">
        <AppIcon name="database" :size="12" />
        {{ status.currentDatabase }}
      </div>
      <div class="status__seg" title="Login">{{ status.currentUser }}</div>
      <div v-if="version" class="status__seg">{{ version }}</div>
      <div
        v-if="status.tunnelPort"
        class="status__seg status__seg--tunnel"
        :title="`${transport} port forward is active`"
      >
        <span class="status__transport">{{ transport }}</span>
        <span class="mono status__seg--strong">:{{ status.tunnelPort }}</span>
      </div>
    </template>

    <div class="status__spacer"></div>

    <div v-if="statementLine !== null" class="status__seg">
      Statement at line {{ statementLine }}
    </div>
    <div class="status__seg">
      {{ schema.totalObjects }} {{ schema.totalObjects === 1 ? 'object' : 'objects' }}
    </div>
    <div class="status__seg">
      {{ tabs.tabs.length }} {{ tabs.tabs.length === 1 ? 'tab' : 'tabs' }}
    </div>

    <div class="status__tools">
      <button
        class="status__btn"
        title="Keyboard shortcuts (Ctrl+/)"
        aria-label="Keyboard shortcuts"
        @click="emit('shortcuts')"
      >
        <AppIcon name="keyboard" :size="14" />
      </button>
      <button class="status__btn" title="Settings" aria-label="Settings" @click="emit('settings')">
        <AppIcon name="settings" :size="14" />
      </button>
      <button
        v-if="status?.state === 'connected'"
        class="status__btn status__btn--disconnect"
        title="Disconnect"
        aria-label="Disconnect"
        @click="emit('disconnect')"
      >
        <AppIcon name="power" :size="14" />
      </button>
    </div>
  </footer>
</template>

<style scoped>
/* A quiet strip of facts across the foot of the window: identity first, then
   where you are, then counts and the window's own controls at the far end. */
.status {
  display: flex;
  align-items: center;
  height: var(--h-statusbar);
  padding: 0 4px 0 6px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-app);
  font-size: 12px;
  flex: 0 0 auto;
  white-space: nowrap;
  overflow: hidden;
}
.status__seg {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 0 9px;
  color: var(--text-muted);
}
.status__seg--id {
  gap: 8px;
  padding: 0 10px 0 8px;
  color: var(--text-primary);
}
.status__seg--strong {
  color: var(--text-secondary);
}
.status__seg--strong .icon {
  color: var(--text-muted);
}
.status__seg--tunnel {
  gap: 6px;
}
/* The read-only switch: a quiet open padlock while the connection can write,
   the closed one and its name while it cannot. */
.status__lock {
  gap: 5px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  cursor: pointer;
  transition:
    background-color var(--transition),
    color var(--transition);
}
.status__lock:hover {
  background: var(--bg-hover-strong);
  color: var(--text-primary);
}
.status__lock--on {
  color: var(--text-secondary);
  font-weight: 500;
}
.status__transport {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 5px;
  border-radius: var(--radius-xs);
  background: var(--accent-soft);
  color: var(--accent-fg);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.status__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  flex: 0 0 auto;
}
.status__dot--connected {
  background: var(--success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 22%, transparent);
}
.status__dot--connecting {
  background: var(--warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 22%, transparent);
}
.status__dot--error {
  background: var(--danger);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 22%, transparent);
}
.status__name {
  font-weight: 600;
}
/* Sits inside the identity segment, because it acts on what that names. */
.status__retry {
  height: 20px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-xs);
  background: var(--accent-soft);
  color: var(--accent-fg);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color var(--transition),
    color var(--transition);
}
.status__retry:hover {
  background: var(--accent);
  color: var(--accent-text);
}
.status__spacer {
  flex: 1;
}
.status__tools {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
  padding-left: 6px;
  border-left: 1px solid var(--border-subtle);
}
.status__btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background-color var(--transition),
    color var(--transition);
}
.status__btn:hover {
  background: var(--bg-hover-strong);
  color: var(--text-primary);
}
.status__btn--disconnect:hover {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}
</style>
