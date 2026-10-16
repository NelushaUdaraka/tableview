<script setup lang="ts">
/**
 * The app's mark, drawn the way the app icon is (build/icon.svg): a table
 * whose header row and middle column make a T, on a graphite tile. It is the
 * brand rather than the accent, so it keeps its colours whichever connection
 * tints the window.
 */
import { useId } from 'vue'

withDefaults(defineProps<{ size?: number }>(), { size: 20 })

// Gradients are looked up by id, and the mark can be on screen twice at once.
const id = useId()
</script>

<template>
  <svg class="brandmark" :width="size" :height="size" viewBox="0 0 48 48" aria-hidden="true">
    <defs>
      <linearGradient :id="`${id}-tile`" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2c3039" />
        <stop offset="1" stop-color="#121418" />
      </linearGradient>
      <linearGradient :id="`${id}-sheen`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity="0.12" />
        <stop offset="0.55" stop-color="#fff" stop-opacity="0" />
      </linearGradient>
    </defs>
    <rect width="48" height="48" rx="11" :fill="`url(#${id}-tile)`" />
    <rect width="48" height="48" rx="11" :fill="`url(#${id}-sheen)`" />
    <path d="M14 10h20a4 4 0 0 1 4 4v4H28v20h-8V18H10v-4a4 4 0 0 1 4-4z" fill="#7390ff" />
    <g fill="#fff" fill-opacity="0.26">
      <rect x="10" y="21" width="7" height="7" rx="1.5" />
      <rect x="31" y="21" width="7" height="7" rx="1.5" />
      <path
        d="M11.5 31h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5H14a4 4 0 0 1-4-4v-1.5a1.5 1.5 0 0 1 1.5-1.5z"
      />
      <path
        d="M32.5 31h4a1.5 1.5 0 0 1 1.5 1.5V34a4 4 0 0 1-4 4h-1.5a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5z"
      />
    </g>
    <rect
      x="0.5"
      y="0.5"
      width="47"
      height="47"
      rx="10.5"
      fill="none"
      stroke="rgba(255, 255, 255, 0.1)"
    />
  </svg>
</template>

<style scoped>
.brandmark {
  display: block;
  flex: 0 0 auto;
}
</style>
