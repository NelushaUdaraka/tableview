<script setup lang="ts">
/**
 * Drawn over the whole window while the app restarts into an update.
 *
 * The app closes for as long as the installer takes — out of sight on
 * Windows, where that can be a minute — and a window that simply vanishes
 * looks like a crash. So it says first what is about to happen, and that
 * TableView opens again on its own. There is nothing to press: by now the
 * unsaved work has been asked about, and the restart is under way.
 */
import { computed } from 'vue'
import { useUpdateStore } from '../stores/updates'

const updates = useUpdateStore()
const version = computed(() => updates.state.version)
</script>

<template>
  <div v-if="updates.state.status === 'installing'" class="installing">
    <div class="installing__card empty-state" role="alertdialog" aria-modal="true" aria-live="assertive">
      <div class="empty-state__icon">
        <span class="spinner"></span>
      </div>
      <div class="empty-state__title">Installing TableView {{ version }}</div>
      <p>
        TableView closes while the update installs, and opens again on its own when it is done.
        This can take a minute.
      </p>
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
