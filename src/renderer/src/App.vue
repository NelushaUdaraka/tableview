<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { MenuAction } from '@shared/menu'
import ConnectionScreen from './views/ConnectionScreen.vue'
import TitleBar from './components/TitleBar.vue'
import WorkspaceView from './views/WorkspaceView.vue'
import ToastHost from './components/ToastHost.vue'
import CredentialsExpiredDialog from './components/CredentialsExpiredDialog.vue'
import { useConnectionStore } from './stores/connections'
import { useSettingsStore } from './stores/settings'
import { useToastStore } from './stores/toasts'
import { dispatchMenuAction } from './lib/menuBus'
import { api } from './lib/api'

const connections = useConnectionStore()
const settings = useSettingsStore()
const toasts = useToastStore()
const ready = ref(false)

let unsubscribeMenu: (() => void) | null = null

onMounted(async () => {
  // Actions from the native menu join the ones the title bar raises, so views
  // only ever subscribe to the bus.
  unsubscribeMenu = api.onMenuAction((action) => dispatchMenuAction(action as MenuAction))
  try {
    await settings.load()
    await connections.load()
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
    <div class="app__body">
      <div v-if="!ready" class="empty-state">
        <span class="spinner"></span>
      </div>
      <WorkspaceView v-else-if="connections.isConnected" />
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
