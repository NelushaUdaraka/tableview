<script setup lang="ts">
/**
 * The app's mark, drawn the way the app icon is: a honey hexagon banded in
 * the tile's own dark, on a rounded tile. It is the brand rather than the
 * accent, so it keeps its colours whichever connection tints the window.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 20 })
</script>

<template>
  <svg class="brandmark" :width="size" :height="size" viewBox="0 0 48 48" aria-hidden="true">
    <rect width="48" height="48" rx="11" fill="#1d2027" />
    <path d="M16 9.75h16l8.3 14.25L32 38.25H16L7.7 24z" fill="#f0a91d" />
    <path d="M6 17.6h36v2.7H6zM6 22.65h36v2.7H6zM6 27.7h36v2.7H6z" fill="#1d2027" />
    <rect
      x="0.5"
      y="0.5"
      width="47"
      height="47"
      rx="10.5"
      fill="none"
      stroke="rgba(255, 255, 255, 0.08)"
    />
  </svg>
</template>

<style scoped>
.brandmark {
  display: block;
  flex: 0 0 auto;
}
</style>
