<script setup lang="ts">
/**
 * A right-click menu, one level of submenus deep.
 *
 * Submenus keep a long menu readable: a data grid has a dozen things worth
 * offering on a row, and the ones that only differ by output format belong
 * folded away behind the verb they share.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface MenuEntry {
  label: string
  action?: string
  danger?: boolean
  separator?: boolean
  disabled?: boolean
  /** Keyboard equivalent, set out on the right the way a native menu does. */
  hint?: string
  /** Nested entries. An entry with these opens on hover instead of acting. */
  items?: MenuEntry[]
}

const props = defineProps<{ x: number; y: number; items: MenuEntry[] }>()
const emit = defineEmits<{
  (event: 'select', action: string): void
  (event: 'close'): void
}>()

const menu = ref<HTMLElement | null>(null)
const position = ref({ x: props.x, y: props.y })
/** Index of the open submenu, and whether it had to open to the left. */
const openSub = ref<number | null>(null)
const subFlipped = ref(false)

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
  if (event.key !== 'Escape') return
  // Escape backs out of a submenu before it closes the menu itself.
  if (openSub.value !== null) openSub.value = null
  else close()
}

function openSubmenu(index: number, event: MouseEvent): void {
  openSub.value = index
  const row = (event.currentTarget as HTMLElement).getBoundingClientRect()
  // Roughly the submenu's own width; enough to know which side it fits on.
  subFlipped.value = row.right + 210 > window.innerWidth
}

function choose(item: MenuEntry): void {
  if (item.disabled || item.items) return
  emit('select', item.action ?? '')
  emit('close')
}

const style = computed(() => ({ left: `${position.value.x}px`, top: `${position.value.y}px` }))
</script>

<template>
  <div ref="menu" class="menu" :style="style" @mousedown.stop>
    <template v-for="(item, index) in items" :key="index">
      <div v-if="item.separator" class="menu__sep"></div>
      <div
        v-else-if="item.items"
        class="menu__row"
        @mouseenter="openSubmenu(index, $event)"
        @mouseleave="openSub = null"
      >
        <button class="menu__item" :disabled="item.disabled">
          <span class="menu__label">{{ item.label }}</span>
          <span class="menu__arrow" aria-hidden="true">›</span>
        </button>
        <div
          v-if="openSub === index"
          class="menu menu--sub"
          :class="{ 'menu--sub-left': subFlipped }"
        >
          <template v-for="(child, childIndex) in item.items" :key="childIndex">
            <div v-if="child.separator" class="menu__sep"></div>
            <button
              v-else
              class="menu__item"
              :class="{ 'menu__item--danger': child.danger }"
              :disabled="child.disabled"
              @click="choose(child)"
            >
              <span class="menu__label">{{ child.label }}</span>
              <span v-if="child.hint" class="menu__hint mono">{{ child.hint }}</span>
            </button>
          </template>
        </div>
      </div>
      <button
        v-else
        class="menu__item"
        :class="{ 'menu__item--danger': item.danger }"
        :disabled="item.disabled"
        @mouseenter="openSub = null"
        @click="choose(item)"
      >
        <span class="menu__label">{{ item.label }}</span>
        <span v-if="item.hint" class="menu__hint mono">{{ item.hint }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.menu {
  position: fixed;
  min-width: 230px;
  padding: 4px 0;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--bg-surface);
  box-shadow: var(--shadow-menu);
  z-index: 300;
}
/* A submenu hangs off its parent row rather than off the viewport. */
.menu--sub {
  position: absolute;
  top: -5px;
  left: 100%;
  min-width: 200px;
}
.menu--sub-left {
  left: auto;
  right: 100%;
}
.menu__row {
  position: relative;
}
.menu__item {
  display: flex;
  align-items: center;
  gap: 16px;
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
.menu__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu__hint,
.menu__arrow {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-size: 11px;
}
.menu__arrow {
  font-size: 14px;
  line-height: 1;
}
.menu__item:hover:not(:disabled),
.menu__row:hover > .menu__item:not(:disabled) {
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
