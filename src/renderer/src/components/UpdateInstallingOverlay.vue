<script setup lang="ts">
/**
 * Drawn over the whole window while the app restarts into an update.
 *
 * A window that simply vanishes looks like a crash, so it says first what is
 * about to happen: on Windows the installer opens in its place and is clicked
 * through, and its last page starts TableView again; an AppImage swaps its
 * file and is back in a moment. There is nothing to press: by now the unsaved
 * work has been asked about, and the restart is under way.
 */
import { computed } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useUpdateStore } from '../stores/updates'

const updates = useUpdateStore()
const settings = useSettingsStore()
const version = computed(() => updates.state.version)
const windows = computed(() => settings.appInfo?.platform === 'win32')
</script>

<template>
  <div v-if="updates.state.status === 'installing'" class="installing">
    <div class="installing__card empty-state" role="alertdialog" aria-modal="true" aria-live="assertive">
      <div class="empty-state__icon">
        <span class="spinner"></span>
      </div>
      <div class="empty-state__title">Installing TableView {{ version }}</div>
      <p v-if="windows">
        TableView closes and the installer opens. Follow it through, and TableView opens again when
        it finishes.
      </p>
      <p v-else>TableView closes and opens again on its own in a moment.</p>
    </div>
  </div>
</template>

<style scoped>
.installing {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--scrim);
  backdrop-filter: blur(2px);
  /* Above dialogs, toasts and menus, since nothing there can be acted on any
     more; under the title bar's (400), whose window buttons still work. */
  z-index: 350;
  animation: fade-in var(--duration) var(--ease);
}
.installing__card {
  width: 400px;
  max-width: 100%;
  height: auto;
  border: 1px solid var(--border-overlay);
  border-radius: var(--radius-lg);
  background: var(--bg-overlay);
  box-shadow: var(--shadow);
  animation: dialog-in var(--duration-slow) var(--ease-out);
}
</style>
