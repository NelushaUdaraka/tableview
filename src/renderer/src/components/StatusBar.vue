<script setup lang="ts">
import { computed } from 'vue'
import { useConnectionStore } from '../stores/connections'
import { useSchemaStore } from '../stores/schema'
import { useTabStore } from '../stores/tabs'

const emit = defineEmits<{
  (event: 'disconnect'): void
  (event: 'settings'): void
  (event: 'shortcuts'): void
}>()

const connections = useConnectionStore()
const schema = useSchemaStore()
const tabs = useTabStore()

const status = computed(() => connections.activeStatus)
const stateLabel = computed(() => {
  switch (status.value?.state) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      return 'Connecting…'
    case 'error':
      return 'Error'
    default:
      return 'Disconnected'
  }
})

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
    <span class="status__dot" :class="`status__dot--${status?.state ?? 'disconnected'}`"></span>
    <span class="status__name">{{ connections.active?.name ?? 'No connection' }}</span>
    <span class="muted">{{ stateLabel }}</span>

    <template v-if="status?.state === 'connected'">
      <span class="status__sep">·</span>
      <span class="muted mono">{{ status.currentDatabase }}</span>
      <span class="status__sep">·</span>
      <span class="muted">{{ status.currentUser }}</span>
      <span v-if="version" class="status__sep">·</span>
      <span v-if="version" class="muted">{{ version }}</span>
      <span v-if="status.tunnelPort" class="status__sep">·</span>
      <span v-if="status.tunnelPort" class="badge" :title="`${transport} port forward is active`">
        {{ transport }} :{{ status.tunnelPort }}
      </span>
    </template>

    <div class="status__spacer"></div>

    <span class="muted">{{ schema.totalObjects }} objects</span>
    <span class="status__sep">·</span>
    <span class="muted">{{ tabs.tabs.length }} tabs</span>

    <button class="status__btn" title="Keyboard shortcuts (Ctrl+/)" @click="emit('shortcuts')">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1" y="4" width="14" height="9" rx="1.5" fill="none" stroke="currentColor" />
        <path d="M4 7h1M7 7h1M10 7h1M4.5 10h6" stroke="currentColor" stroke-linecap="round" />
      </svg>
    </button>
    <button class="status__btn" title="Settings" @click="emit('settings')">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" />
        <path
          d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4"
          stroke="currentColor"
          stroke-linecap="round"
        />
      </svg>
    </button>
    <button
      v-if="status?.state === 'connected'"
      class="status__btn"
      title="Disconnect"
      @click="emit('disconnect')"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.8v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        <path
          d="M4.6 4.2a5 5 0 1 0 6.8 0"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </footer>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 24px;
  padding: 0 4px 0 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-raised);
  font-size: 11px;
  flex: 0 0 auto;
  white-space: nowrap;
  overflow: hidden;
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
}
.status__dot--connecting {
  background: var(--warning);
}
.status__dot--error {
  background: var(--danger);
}
.status__name {
  font-weight: 600;
}
.status__sep {
  color: var(--text-muted);
  opacity: 0.5;
}
.status__spacer {
  flex: 1;
}
.status__btn {
  height: 20px;
  min-width: 22px;
  padding: 0 5px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
}
.status__btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.status__btn svg {
  width: 13px;
  height: 13px;
  display: block;
  margin: 0 auto;
  stroke-width: 1.3;
  fill: none;
}
</style>
