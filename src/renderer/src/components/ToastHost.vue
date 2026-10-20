<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import type { IconName } from '../lib/icons'
import { useToastStore } from '../stores/toasts'

const toasts = useToastStore()

const ICON: Record<'info' | 'success' | 'error', IconName> = {
  info: 'info',
  success: 'circle-check',
  error: 'circle-x'
}
</script>

<template>
  <div class="toasts">
    <div
      v-for="toast in toasts.toasts"
      :key="toast.id"
      class="toast"
      :class="`toast--${toast.kind}`"
      :role="toast.kind === 'error' ? 'alert' : 'status'"
    >
      <AppIcon class="toast__icon" :name="ICON[toast.kind]" :size="16" />
      <div class="toast__body">
        <div class="toast__message">{{ toast.message }}</div>
        <div v-if="toast.detail" class="toast__detail selectable">{{ toast.detail }}</div>
        <button v-if="toast.action" class="btn btn--sm toast__action" @click="toasts.act(toast.id)">
          {{ toast.action.label }}
        </button>
      </div>
      <button
        class="btn btn--ghost btn--icon btn--sm toast__close"
        title="Dismiss"
        aria-label="Dismiss"
        @click="toasts.dismiss(toast.id)"
      >
        <AppIcon name="x" :size="14" />
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
  bottom: calc(var(--h-statusbar) + 14px);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  width: min(420px, calc(100vw - 32px));
  z-index: 200;
  /* Only the toasts themselves take clicks — not the gaps between them. */
  pointer-events: none;
}
/* The state is said by the icon, in its colour, rather than by a stripe. */
.toast {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 10px 12px 14px;
  border: 1px solid var(--border-overlay);
  border-radius: 10px;
  background: var(--bg-overlay);
  box-shadow: var(--shadow-menu);
  pointer-events: auto;
  animation: rise-in var(--duration-slow) var(--ease-out);
}
.toast__icon {
  margin-top: 1px;
}
.toast--success .toast__icon {
  color: var(--success);
}
.toast--error .toast__icon {
  color: var(--danger);
}
.toast--info .toast__icon {
  color: var(--accent-fg);
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
  line-height: 18px;
  overflow-wrap: anywhere;
}
/* Pinned to the top-right corner, level with the first line of the message. */
.toast__close {
  flex: 0 0 auto;
  margin: -3px 0 0 auto;
}
/* What the toast offers to do, under what it says. */
.toast__action {
  margin-top: 10px;
}
.toast__detail {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
