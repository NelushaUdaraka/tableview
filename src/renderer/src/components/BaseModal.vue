<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import AppIcon from './AppIcon.vue'
import { closeModal, isTopModal, openModal } from '../lib/modalStack'

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

/** This dialog's place in the stack, so Escape closes only the one on top. */
let place: symbol | null = null

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !place || !isTopModal(place)) return
  event.stopPropagation()
  emit('close')
}

onMounted(() => {
  place = openModal()
  document.addEventListener('keydown', onKeydown, true)
})
onBeforeUnmount(() => {
  if (place) closeModal(place)
  document.removeEventListener('keydown', onKeydown, true)
})
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
        <button class="modal__close" title="Close" aria-label="Close" @click="emit('close')">
          <AppIcon name="x" :size="16" />
        </button>
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
  background: var(--scrim);
  backdrop-filter: blur(2px);
  z-index: 100;
  animation: fade-in var(--duration) var(--ease);
}
.modal {
  display: flex;
  flex-direction: column;
  max-width: 100%;
  max-height: 88vh;
  border: 1px solid var(--border-overlay);
  border-radius: var(--radius-lg);
  background: var(--bg-overlay);
  box-shadow: var(--shadow);
  overflow: hidden;
  animation: dialog-in var(--duration-slow) var(--ease-out);
}
.modal__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 16px 16px 20px;
  border-bottom: 1px solid var(--border-subtle);
  flex: 0 0 auto;
}
.modal__heading {
  min-width: 0;
}
.modal__heading .kicker {
  margin-bottom: 4px;
}
.modal__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
}
.modal__subtitle {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
.modal__close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  margin-top: -2px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background-color var(--transition),
    color var(--transition);
}
.modal__close:hover {
  background: var(--bg-hover-strong);
  color: var(--text-primary);
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
  gap: 8px;
  padding: 12px 16px 12px 20px;
  border-top: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-app) 55%, var(--bg-overlay));
  flex: 0 0 auto;
}
.modal__foot .btn {
  height: var(--h-control-lg);
}
</style>
