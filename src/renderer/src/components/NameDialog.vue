<script setup lang="ts">
/**
 * Asks for a single name.
 *
 * Stands in for `window.prompt`, which Electron does not implement: there it
 * throws instead of asking, so anything built on it silently did nothing.
 */
import { nextTick, onMounted, ref } from 'vue'
import BaseModal from './BaseModal.vue'

const props = withDefaults(
  defineProps<{
    title: string
    label?: string
    initial?: string
    confirmLabel?: string
  }>(),
  { label: 'Name', initial: '', confirmLabel: 'Save' }
)

const emit = defineEmits<{
  (event: 'confirm', name: string): void
  (event: 'close'): void
}>()

const name = ref(props.initial)
const input = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  await nextTick()
  input.value?.focus()
  input.value?.select()
})

function confirm(): void {
  const value = name.value.trim()
  if (value) emit('confirm', value)
}
</script>

<template>
  <BaseModal :title="title" width="420px" @close="emit('close')">
    <label class="field">
      <span class="field__label">{{ label }}</span>
      <input ref="input" v-model="name" class="input" @keydown.enter.prevent="confirm" />
    </label>

    <template #footer>
      <button class="btn btn--muted" @click="emit('close')">Cancel</button>
      <button class="btn btn--primary" :disabled="!name.trim()" @click="confirm">
        {{ confirmLabel }}
      </button>
    </template>
  </BaseModal>
</template>
