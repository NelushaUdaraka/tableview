<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

withDefaults(
  defineProps<{ title: string; width?: string; subtitle?: string }>(),
  { width: '540px', subtitle: '' }
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
        <div>
          <h2 class="modal__title">{{ title }}</h2>
          <p v-if="subtitle" class="modal__subtitle">{{ subtitle }}</p>
        </div>
        <button class="btn btn--ghost btn--icon" title="Close" @click="emit('close')">✕</button>
      </header>
      <div class="modal__body">
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
  border-radius: var(--radius);
  background: var(--bg-overlay);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.modal__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.modal__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.modal__subtitle {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
.modal__body {
  flex: 1;
  min-height: 0;
  padding: 16px;
  overflow: auto;
}
.modal__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-raised);
}
</style>
