<script setup lang="ts">
/**
 * An icon from the window's set (see lib/icons.ts).
 *
 * Decorative by default: the button or label it sits in carries the name, so
 * it is hidden from assistive technology rather than read out as a picture.
 * The stroke thickens as the icon shrinks, so a 12px mark is as legible as a
 * 16px one rather than a hairline.
 */
import { computed } from 'vue'
import { ICONS, type IconName } from '../lib/icons'

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 16 })

const shapes = computed(() =>
  ICONS[props.name].map((shape) =>
    typeof shape === 'string' ? { d: shape, fill: false } : { d: shape.d, fill: true }
  )
)
const stroke = computed(() => (props.size <= 12 ? 2.3 : props.size <= 14 ? 2 : 1.8))
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path
      v-for="(shape, index) in shapes"
      :key="index"
      :d="shape.d"
      :fill="shape.fill ? 'currentColor' : undefined"
      :stroke="shape.fill ? 'none' : undefined"
    />
  </svg>
</template>
