<script setup lang="ts">
import { useToastStore } from '../stores/toasts'

const toasts = useToastStore()
</script>

<template>
  <div class="toasts">
    <div
      v-for="toast in toasts.toasts"
      :key="toast.id"
      class="toast"
      :class="`toast--${toast.kind}`"
    >
      <div class="toast__body">
        <div class="toast__message">{{ toast.message }}</div>
        <div v-if="toast.detail" class="toast__detail selectable">{{ toast.detail }}</div>
      </div>
      <button class="btn btn--ghost btn--icon btn--sm" @click="toasts.dismiss(toast.id)">✕</button>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 16px;
  bottom: calc(var(--h-statusbar) + 12px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 420px;
  z-index: 200;
}
/* The state is marked on the leading edge, like every other staged thing. */
.toast {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--bg-surface);
  box-shadow: var(--shadow-menu);
}
.toast--success {
  box-shadow: inset 3px 0 0 var(--success), var(--shadow-menu);
}
.toast--error {
  box-shadow: inset 3px 0 0 var(--danger), var(--shadow-menu);
}
.toast--info {
  box-shadow: inset 3px 0 0 var(--accent), var(--shadow-menu);
}
.toast__message {
  font-weight: 600;
  font-size: 13px;
}
.toast__detail {
  margin-top: 5px;
  font-size: 12px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
