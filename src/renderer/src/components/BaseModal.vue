<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

withDefaults(
  defineProps<{
    title: string
    width?: string
    subtitle?: string
    /** Accent micro-caps above the title, naming what the dialog is for. */
    kicker?: string
    /** Drop the body's padding so a list can run to the dialog's edges. */
    flush?: boolean
  }>(),
  { width: '540px', subtitle: '', kicker: '', flush: false }
)

const emit = defineEmits<{ (event: 'close'): void }>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <div class="backdrop" @mousedown.self="emit('close')">
    <div class="modal" :style="{ width }" role="dialog" aria-modal="true">
      <header class="modal__head">
        <div class="modal__heading">
          <div v-if="kicker" class="kicker">{{ kicker }}</div>
          <h2 class="modal__title">{{ title }}</h2>
          <p v-if="subtitle" class="modal__subtitle mono">{{ subtitle }}</p>
        </div>
        <button class="modal__close" title="Close" @click="emit('close')">✕</button>
      </header>
      <div class="modal__body" :class="{ 'modal__body--flush': flush }">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="modal__foot">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
}
.modal {
  display: flex;
  flex-direction: column;
  max-height: 88vh;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--bg-surface);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: var(--rule) solid var(--border-strong);
  background: var(--bg-app);
  flex: 0 0 auto;
}
.modal__heading {
  min-width: 0;
}
.modal__title {
  margin: 2px 0 0;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.01em;
}
.modal__subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
.modal__close {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.modal__close:hover {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}
.modal__body {
  flex: 1;
  min-height: 0;
  padding: 20px;
  overflow: auto;
}
.modal__body--flush {
  padding: 0;
}
.modal__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: var(--rule) solid var(--border-strong);
  background: var(--bg-app);
  flex: 0 0 auto;
}
.modal__foot .btn {
  height: var(--h-control-lg);
}
</style>
