<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { MenuAction } from '@shared/menu'
import ConnectionScreen from './views/ConnectionScreen.vue'
import TitleBar from './components/TitleBar.vue'
import ProgressBar from './components/ProgressBar.vue'
import WorkspaceView from './views/WorkspaceView.vue'
import ToastHost from './components/ToastHost.vue'
import CredentialsExpiredDialog from './components/CredentialsExpiredDialog.vue'
import { useConnectionStore } from './stores/connections'
import { useSettingsStore } from './stores/settings'
import { useTabStore } from './stores/tabs'
import { useToastStore } from './stores/toasts'
import { dispatchMenuAction } from './lib/menuBus'
import { api } from './lib/api'

const connections = useConnectionStore()
const settings = useSettingsStore()
const tabs = useTabStore()
const toasts = useToastStore()
const ready = ref(false)

/**
 * Opens the tab this window was created for, if it was created for one.
 *
 * A tab dragged out of another window arrives as a description, not as state:
 * this window has its own connection pool, so it connects for itself before it
 * can show anything. Done before the workspace is shown, so it opens onto the
 * tab rather than onto a blank query.
 */
async function openDetachedTab(): Promise<void> {
  const pending = await api.takePendingTab()
  if (!pending) return

  const status = await connections.connect(pending.connectionId)
  if (status.state !== 'connected') {
    toasts.error('Could not open that tab in this window', status.error?.message)
    return
  }

  if (pending.kind === 'table' && pending.schema && pending.table) {
    await tabs.openTable(
      pending.connectionId,
      pending.schema,
      pending.table,
      pending.objectType ?? 'table',
      pending.view ?? 'data'
    )
  } else {
    await tabs.openQuery(pending.connectionId, pending.sql ?? '', pending.title)
  }
}

let unsubscribeMenu: (() => void) | null = null

onMounted(async () => {
  // Actions from the native menu join the ones the title bar raises, so views
  // only ever subscribe to the bus.
  unsubscribeMenu = api.onMenuAction((action) => dispatchMenuAction(action as MenuAction))
  try {
    await settings.load()
    await connections.load()
    await openDetachedTab()
  } catch (error) {
    toasts.fromError('Could not start up cleanly', error)
  } finally {
    ready.value = true
  }
})

onBeforeUnmount(() => unsubscribeMenu?.())
</script>

<template>
  <div class="app">
    <TitleBar />
    <!-- Spans the window, under the title bar: whatever is loading, it shows here. -->
    <ProgressBar />
    <div class="app__body">
      <div v-if="!ready" class="empty-state">
        <span class="spinner"></span>
      </div>
      <!-- The session, not the socket: a connection being reopened keeps its
           tabs rather than dropping back to the connection screen. -->
      <WorkspaceView v-else-if="connections.inSession" />
      <ConnectionScreen v-else />
    </div>
    <ToastHost />
    <!-- Raised from anywhere a session can run out, so it lives above the views. -->
    <CredentialsExpiredDialog />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.app__body {
  flex: 1;
  min-height: 0;
}
</style>
