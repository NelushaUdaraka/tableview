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
  bottom: 34px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 420px;
  z-index: 200;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 10px 10px 12px;
  border: 1px solid var(--border-strong);
  border-left-width: 3px;
  border-radius: var(--radius-sm);
  background: var(--bg-overlay);
  box-shadow: var(--shadow);
}
.toast--success {
  border-left-color: var(--success);
}
.toast--error {
  border-left-color: var(--danger);
}
.toast--info {
  border-left-color: var(--info);
}
.toast__message {
  font-weight: 600;
  font-size: 12px;
}
.toast__detail {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
