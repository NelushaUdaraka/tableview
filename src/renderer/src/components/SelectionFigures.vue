<script setup lang="ts">
/**
 * The selected rows' figures for the focused column, in a line: what a
 * spreadsheet's status bar says about a selection.
 */
import { computed } from 'vue'
import { figureParts, type SelectionFigures } from '../lib/selectionFigures'

const props = defineProps<{
  figures: SelectionFigures
  column: string
  /** What the rows are out of, when that is less than everything — "this page". */
  scope?: string
}>()

const parts = computed(() => figureParts(props.figures))

const title = computed(() => {
  const over = props.scope ? `the ${props.figures.rows} selected rows of ${props.scope}` : `the ${props.figures.rows} selected rows`
  const nulls = props.figures.nulls > 0 ? ' NULLs are left out of the figures and counted apart.' : ''
  return `${props.column}, over ${over}.${nulls}`
})
</script>

<template>
  <span class="figures" :title="title">
    <span class="figures__column mono truncate">{{ column }}</span>
    <span class="figures__rows">
      {{ figures.rows }} rows<template v-if="scope"> on {{ scope }}</template>
    </span>
    <span v-for="part in parts" :key="part.label" class="figures__part">
      <span class="figures__label">{{ part.label }}</span>
      <span class="figures__value num">{{ part.value }}</span>
    </span>
  </span>
</template>

<style scoped>
.figures {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}
.figures__column {
  flex: 0 1 auto;
  max-width: 160px;
  color: var(--text-secondary);
}
.figures__rows {
  flex: 0 0 auto;
}
.figures__part {
  display: inline-flex;
  gap: 4px;
  flex: 0 0 auto;
}
.figures__value {
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
</style>
