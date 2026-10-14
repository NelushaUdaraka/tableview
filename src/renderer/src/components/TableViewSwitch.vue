<script setup lang="ts">
/**
 * The Data/Structure switch.
 *
 * It lives in each view's command bar rather than in a strip of its own — the
 * two used to be stacked, which spent a whole horizontal band on one choice.
 */
import AppIcon from './AppIcon.vue'
import { useTabStore } from '../stores/tabs'
import type { TableTab } from '../stores/tabs'

const props = defineProps<{ tab: TableTab }>()
const tabs = useTabStore()

/** Asks first when it would take the rows, and the edits staged in them, off screen. */
function setView(view: 'data' | 'structure'): void {
  void tabs.setTableView(props.tab.id, view)
}
</script>

<template>
  <div class="seg seg--caps">
    <button
      class="seg__opt"
      :class="{ 'seg__opt--on': tab.view === 'data' }"
      @click="setView('data')"
    >
      <AppIcon name="table" :size="13" />
      Data
      <span v-if="tab.pendingEdits > 0" class="seg__count">{{ tab.pendingEdits }}</span>
    </button>
    <button
      class="seg__opt"
      :class="{ 'seg__opt--on': tab.view === 'structure' }"
      @click="setView('structure')"
    >
      <AppIcon name="list" :size="13" />
      Structure
    </button>
  </div>
</template>
