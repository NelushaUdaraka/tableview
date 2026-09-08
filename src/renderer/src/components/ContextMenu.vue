<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface MenuEntry {
  label: string
  action?: string
  danger?: boolean
  separator?: boolean
  disabled?: boolean
}

const props = defineProps<{ x: number; y: number; items: MenuEntry[] }>()
const emit = defineEmits<{
  (event: 'select', action: string): void
  (event: 'close'): void
}>()

const menu = ref<HTMLElement | null>(null)
const position = ref({ x: props.x, y: props.y })

/** Nudges the menu back on-screen when it would overflow. */
onMounted(() => {
  const rect = menu.value?.getBoundingClientRect()
  if (!rect) return
  position.value = {
    x: Math.min(props.x, window.innerWidth - rect.width - 8),
    y: Math.min(props.y, window.innerHeight - rect.height - 8)
  }
  setTimeout(() => {
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
  }, 0)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', close)
  document.removeEventListener('keydown', onKey)
})

function close(): void {
  emit('close')
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

const style = computed(() => ({ left: `${position.value.x}px`, top: `${position.value.y}px` }))
</script>

<template>
  <div ref="menu" class="menu" :style="style" @mousedown.stop>
    <template v-for="(item, index) in items" :key="index">
      <div v-if="item.separator" class="menu__sep"></div>
      <button
        v-else
        class="menu__item"
        :class="{ 'menu__item--danger': item.danger }"
        :disabled="item.disabled"
        @click="emit('select', item.action ?? ''), emit('close')"
      >
        {{ item.label }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.menu {
  position: fixed;
  min-width: 210px;
  padding: 4px 0;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--bg-surface);
  box-shadow: var(--shadow-menu);
  z-index: 300;
}
.menu__item {
  display: block;
  width: 100%;
  padding: 7px 14px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  font-size: 13px;
  cursor: pointer;
}
.menu__item:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}
.menu__item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.menu__item--danger {
  color: var(--danger);
}
.menu__sep {
  height: 1px;
  margin: 4px 0;
  background: var(--border-strong);
}
</style>
