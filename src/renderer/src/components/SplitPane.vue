<script setup lang="ts">
/** Two panes with a draggable divider. Size is the first pane's extent in px. */
import { onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    direction?: 'horizontal' | 'vertical'
    modelValue: number
    min?: number
    max?: number
    collapsed?: boolean
  }>(),
  { direction: 'horizontal', min: 140, max: 900, collapsed: false }
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
  const raw =
    props.direction === 'horizontal' ? event.clientX - rect.left : event.clientY - rect.top
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
      v-show="!collapsed"
      class="split__first"
      :style="
        direction === 'horizontal'
          ? { width: `${size}px`, flex: `0 0 ${size}px` }
          : { height: `${size}px`, flex: `0 0 ${size}px` }
      "
    >
      <slot name="first" />
    </div>
    <div
      v-show="!collapsed"
      class="split__divider"
      :class="{ 'split__divider--active': dragging }"
      @mousedown="onMouseDown"
    ></div>
    <div class="split__second">
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
.split__second {
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
