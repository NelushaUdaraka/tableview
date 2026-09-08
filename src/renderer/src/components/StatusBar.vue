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
      <span v-if="status?.state !== 'connected'" class="muted">{{ stateLabel }}</span>
    </div>

    <template v-if="status?.state === 'connected'">
      <div class="status__seg mono status__seg--strong">{{ status.currentDatabase }}</div>
      <div class="status__seg mono">{{ status.currentUser }}</div>
      <div v-if="version" class="status__seg mono">{{ version }}</div>
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

    <div v-if="statementLine !== null" class="status__seg mono">
      Statement at line {{ statementLine }}
    </div>
    <div class="status__seg mono">{{ schema.totalObjects }} objects</div>
    <div class="status__seg mono">{{ tabs.tabs.length }} tabs</div>

    <button class="status__btn" title="Keyboard shortcuts (Ctrl+/)" @click="emit('shortcuts')">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1" y="4" width="14" height="9" fill="none" stroke="currentColor" />
        <path d="M4 7h1M7 7h1M10 7h1M4.5 10h6" stroke="currentColor" />
      </svg>
    </button>
    <button class="status__btn" title="Settings" @click="emit('settings')">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" />
        <path
          d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4"
          stroke="currentColor"
        />
      </svg>
    </button>
    <button
      v-if="status?.state === 'connected'"
      class="status__btn status__btn--disconnect"
      title="Disconnect"
      @click="emit('disconnect')"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.8v6" stroke="currentColor" stroke-width="1.7" />
        <path d="M4.6 4.2a5 5 0 1 0 6.8 0" fill="none" stroke="currentColor" stroke-width="1.7" />
      </svg>
    </button>
  </footer>
</template>

<style scoped>
/* Segments are divided by rules, not by dot separators — each fact gets its own
   ruled cell across the foot of the window. */
.status {
  display: flex;
  align-items: stretch;
  height: var(--h-statusbar);
  border-top: var(--rule) solid var(--border-strong);
  background: var(--bg-raised);
  font-size: 11px;
  flex: 0 0 auto;
  white-space: nowrap;
  overflow: hidden;
}
.status__seg {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-left: 1px solid var(--border-strong);
  color: var(--text-muted);
  font-size: 11px;
}
/* The identity segment opens the bar, so it carries no dividing rule. */
.status__seg--id {
  padding: 0 14px;
  border-left: none;
  color: var(--text-primary);
}
.status__seg--strong {
  color: var(--text-secondary);
}
.status__seg--tunnel {
  gap: 7px;
}
.status__transport {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--accent);
}
.status__dot {
  width: 8px;
  height: 8px;
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
  font-size: 13px;
}
.status__spacer {
  flex: 1;
}
.status__btn {
  width: 36px;
  border: none;
  border-left: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.status__btn:hover {
  background: var(--bg-hover-strong);
  color: var(--text-primary);
}
.status__btn--disconnect:hover {
  background: var(--accent);
  color: var(--accent-text);
}
.status__btn svg {
  width: 14px;
  height: 14px;
  display: block;
  margin: 0 auto;
  stroke-width: 1.3;
  fill: none;
}
</style>
