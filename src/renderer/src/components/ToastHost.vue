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
      <button
        class="btn btn--ghost btn--icon btn--sm toast__close"
        title="Dismiss"
        aria-label="Dismiss"
        @click="toasts.dismiss(toast.id)"
      >
        ✕
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * One column of toasts, all of one width.
 *
 * The width is fixed rather than fitted to the message: toasts stack, and a
 * column that re-measures itself every time one arrives or fades moves the
 * dismiss button out from under the pointer on its way to it.
 */
.toasts {
  position: fixed;
  right: 16px;
  bottom: calc(var(--h-statusbar) + 12px);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  width: min(420px, calc(100vw - 32px));
  z-index: 200;
  /* Only the toasts themselves take clicks — not the gaps between them. */
  pointer-events: none;
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
  pointer-events: auto;
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
/*
 * The text takes the room the button does not.
 *
 * Without this the button would sit wherever the message happened to end,
 * which is a different place in every toast; `min-width: 0` is what lets a
 * long detail wrap instead of pushing the button off the edge of the toast.
 */
.toast__body {
  flex: 1 1 auto;
  min-width: 0;
}
.toast__message {
  font-weight: 600;
  font-size: 13px;
  overflow-wrap: anywhere;
}
/* Pinned to the top-right corner, level with the first line of the message. */
.toast__close {
  flex: 0 0 auto;
  margin: -3px -7px 0 auto;
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
