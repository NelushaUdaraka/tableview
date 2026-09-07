<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ConnectionScreen from './views/ConnectionScreen.vue'
import WorkspaceView from './views/WorkspaceView.vue'
import ToastHost from './components/ToastHost.vue'
import { useConnectionStore } from './stores/connections'
import { useSettingsStore } from './stores/settings'
import { useToastStore } from './stores/toasts'

const connections = useConnectionStore()
const settings = useSettingsStore()
const toasts = useToastStore()
const ready = ref(false)

onMounted(async () => {
  try {
    await settings.load()
    await connections.load()
  } catch (error) {
    toasts.fromError('Could not start up cleanly', error)
  } finally {
    ready.value = true
  }
})
</script>

<template>
  <div class="app">
    <div v-if="!ready" class="empty-state">
      <span class="spinner"></span>
    </div>
    <WorkspaceView v-else-if="connections.isConnected" />
    <ConnectionScreen v-else />
    <ToastHost />
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  min-height: 0;
}
</style>
