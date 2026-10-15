<script setup lang="ts">
/**
 * The box AWS credentials are pasted into, and a button that does the paste.
 *
 * The access portal hands out a fresh block every few hours, so pasting one is
 * the thing most often done to a connection's AWS settings. The button reads
 * the clipboard through the main process, which hands over a credential block
 * and nothing else; the line under the box then says straight away what was
 * pasted — the key, masked, its region and when it runs out — or what is wrong
 * with it, rather than leaving that to Save or to the next connect.
 */
import { computed, ref, useId, watch } from 'vue'
import { checkCredentialBlock, describeCredentials } from '@shared/aws/credentials'
import AppIcon from './AppIcon.vue'
import { api } from '../lib/api'

const props = withDefaults(
  defineProps<{
    modelValue: string
    label: string
    /** What the line under the box says while it is empty. */
    hint: string
    rows?: number
  }>(),
  { rows: 4 }
)
const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>()

const id = useId()
const box = ref<HTMLTextAreaElement | null>(null)
const pasting = ref(false)
/** Why the last paste did not happen. Any change to the box makes it moot. */
const pasteError = ref('')
watch(
  () => props.modelValue,
  () => {
    pasteError.value = ''
  }
)

const check = computed(() => checkCredentialBlock(props.modelValue))

const status = computed<{ kind: 'error' | 'found' | 'hint'; text: string }>(() => {
  if (pasteError.value) return { kind: 'error', text: pasteError.value }
  if (check.value.error) return { kind: 'error', text: check.value.error }
  if (check.value.credentials) {
    return { kind: 'found', text: describeCredentials(check.value.credentials) }
  }
  return { kind: 'hint', text: props.hint }
})

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}

async function pasteFromClipboard(): Promise<void> {
  pasting.value = true
  pasteError.value = ''
  try {
    // A block replaces what was in the box: it is a whole, not something to add to.
    emit('update:modelValue', await api.readAwsCredentialsFromClipboard())
  } catch (error) {
    pasteError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pasting.value = false
  }
}

defineExpose({ focus: () => box.value?.focus() })
</script>

<template>
  <div class="field credbox">
    <div class="credbox__head">
      <label class="field__label" :for="`${id}-box`">{{ label }}</label>
      <button
        type="button"
        class="btn btn--sm credbox__paste"
        :disabled="pasting"
        @click="pasteFromClipboard"
      >
        <span v-if="pasting" class="spinner"></span>
        <AppIcon v-else name="clipboard-paste" :size="14" />
        Paste from clipboard
      </button>
    </div>
    <textarea
      :id="`${id}-box`"
      ref="box"
      class="textarea credbox__box"
      :value="modelValue"
      :rows="rows"
      spellcheck="false"
      autocomplete="off"
      :aria-describedby="`${id}-status`"
      :aria-invalid="status.kind === 'error'"
      placeholder="export AWS_ACCESS_KEY_ID=&quot;ASIA…&quot;&#10;export AWS_SECRET_ACCESS_KEY=&quot;…&quot;&#10;export AWS_SESSION_TOKEN=&quot;…&quot;"
      @input="onInput"
    ></textarea>
    <!-- Polite, so a screen reader hears what the paste found without the
         focus leaving the button that did it. -->
    <span
      :id="`${id}-status`"
      class="field__hint credbox__status"
      :class="{
        'error-text': status.kind === 'error',
        'credbox__status--found': status.kind === 'found'
      }"
      aria-live="polite"
    >
      <AppIcon
        v-if="status.kind === 'found'"
        class="credbox__found-mark"
        name="circle-check"
        :size="12"
      />
      {{ status.text }}
    </span>
  </div>
</template>

<style scoped>
.credbox__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.credbox__paste {
  flex: 0 0 auto;
}
.credbox__box {
  min-height: 88px;
  font-size: 11px;
  line-height: 1.5;
}
.credbox__status--found {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
}
.credbox__found-mark {
  flex: 0 0 auto;
  color: var(--success);
}
</style>
