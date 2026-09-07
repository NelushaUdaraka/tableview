<script setup lang="ts">
/**
 * Two panes with a draggable divider.
 *
 * `modelValue` is the extent, in pixels, of whichever pane `pane` names — the
 * first one by default, which is the sidebar; the second when the fixed pane
 * is on the right, like the row inspector. The other pane takes the rest.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    direction?: 'horizontal' | 'vertical'
    modelValue: number
    min?: number
    max?: number
    /** Hides the sized pane and the divider, keeping the other one whole. */
    collapsed?: boolean
    pane?: 'first' | 'second'
  }>(),
  { direction: 'horizontal', min: 140, max: 900, collapsed: false, pane: 'first' }
)

const emit = defineEmits<{ (event: 'update:modelValue', value: number): void }>()

const root = ref<HTMLElement | null>(null)
const dragging = ref(false)
const size = ref(props.modelValue)

watch(
  () => props.modelValue,
  (next) => {
    size.value = next
  }
)

const sizeStyle = computed(() =>
  props.direction === 'horizontal'
    ? { width: `${size.value}px`, flex: `0 0 ${size.value}px` }
    : { height: `${size.value}px`, flex: `0 0 ${size.value}px` }
)

function onMouseDown(event: MouseEvent): void {
  event.preventDefault()
  dragging.value = true
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  document.body.style.cursor = props.direction === 'horizontal' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'
}

function onMouseMove(event: MouseEvent): void {
  if (!dragging.value || !root.value) return
  const rect = root.value.getBoundingClientRect()
  // A pane on the far side grows as the pointer moves towards its own edge.
  const raw =
    props.direction === 'horizontal'
      ? props.pane === 'first'
        ? event.clientX - rect.left
        : rect.right - event.clientX
      : props.pane === 'first'
        ? event.clientY - rect.top
        : rect.bottom - event.clientY
  size.value = Math.min(props.max, Math.max(props.min, raw))
  emit('update:modelValue', size.value)
}

function onMouseUp(): void {
  dragging.value = false
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onBeforeUnmount(onMouseUp)
</script>

<template>
  <div ref="root" class="split" :class="`split--${direction}`">
    <div
      v-show="!(collapsed && pane === 'first')"
      class="split__first"
      :class="{ 'split__pane--flex': pane === 'second' }"
      :style="pane === 'first' ? sizeStyle : undefined"
    >
      <slot name="first" />
    </div>
    <div
      v-show="!collapsed"
      class="split__divider"
      :class="{ 'split__divider--active': dragging }"
      @mousedown="onMouseDown"
    ></div>
    <div
      v-show="!(collapsed && pane === 'second')"
      class="split__second"
      :class="{ 'split__pane--flex': pane === 'first' }"
      :style="pane === 'second' ? sizeStyle : undefined"
    >
      <slot name="second" />
    </div>
  </div>
</template>

<style scoped>
.split {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
.split--horizontal {
  flex-direction: row;
}
.split--vertical {
  flex-direction: column;
}
.split__first,
.split__second {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.split__pane--flex {
  flex: 1;
}
.split__divider {
  flex: 0 0 4px;
  background: var(--border);
  transition: background var(--transition);
}
.split--horizontal > .split__divider {
  cursor: col-resize;
}
.split--vertical > .split__divider {
  cursor: row-resize;
}
.split__divider:hover,
.split__divider--active {
  background: var(--border-focus);
}
</style>
