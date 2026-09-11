<script setup lang="ts">
/**
 * The window-wide progress bar: one rule's worth of accent under the title bar.
 *
 * It is indeterminate because nothing here knows how far through a server round
 * trip it is. It occupies no space — the bar is drawn over the top edge of the
 * body — so raising and lowering it never moves the view underneath.
 */
import { useBusyStore } from '../stores/busy'

const busy = useBusyStore()
</script>

<template>
  <div class="progress" :class="{ 'progress--on': busy.busy }" role="progressbar" aria-busy="true">
    <div class="progress__sweep"></div>
  </div>
</template>

<style scoped>
.progress {
  position: relative;
  z-index: 40;
  /* Always laid out, so the body below never shifts when a load starts. */
  height: 2px;
  margin-bottom: -2px;
  overflow: hidden;
  opacity: 0;
  transition: opacity var(--transition);
  pointer-events: none;
}
.progress--on {
  opacity: 1;
}
.progress__sweep {
  width: 40%;
  height: 100%;
  background: var(--accent);
  /* Paused until the bar is up, so an idle window animates nothing. */
  animation: progress-sweep 1100ms ease-in-out infinite;
  animation-play-state: paused;
}
.progress--on .progress__sweep {
  animation-play-state: running;
}
@keyframes progress-sweep {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(350%);
  }
}
</style>
