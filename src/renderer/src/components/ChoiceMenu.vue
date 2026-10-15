<script setup lang="ts" generic="T extends string | number">
/**
 * One choice out of a few, dropped from the button that shows it.
 *
 * Each entry is a radio item. The one in force carries the tick the
 * right-click menu marks a current sort with, and the focus starts on it, so
 * opening the menu and pressing Enter changes nothing.
 */
import AppIcon from './AppIcon.vue'
import PopoverPanel from './PopoverPanel.vue'

defineProps<{
  anchor: HTMLElement | null
  label: string
  choices: readonly { value: T; label: string }[]
  value: T
}>()

const emit = defineEmits<{
  (event: 'choose', value: T): void
  (event: 'close'): void
}>()

function choose(value: T): void {
  emit('choose', value)
  emit('close')
}
</script>

<template>
  <PopoverPanel :anchor="anchor" :label="label" role="menu" @close="emit('close')">
    <button
      v-for="choice in choices"
      :key="choice.value"
      class="choice"
      role="menuitemradio"
      :aria-checked="choice.value === value"
      :data-value="choice.value"
      data-popover-item
      :data-popover-autofocus="choice.value === value ? '' : undefined"
      @click="choose(choice.value)"
    >
      <span class="choice__label">{{ choice.label }}</span>
      <AppIcon v-if="choice.value === value" class="choice__check" name="check" :size="14" />
    </button>
  </PopoverPanel>
</template>

<style scoped>
/* The right-click menu's entries, so a menu reads as a menu wherever it opens. */
.choice {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  height: 28px;
  flex: 0 0 auto;
  padding: 0 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}
.choice:hover {
  background: var(--bg-hover-strong);
}
.choice__label {
  flex: 1;
  min-width: 0;
}
.choice__check {
  color: var(--accent-fg);
}
</style>
