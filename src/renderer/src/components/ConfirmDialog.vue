<script setup lang="ts">
/**
 * The app's own yes-or-no question (`stores/confirm.ts`), in place of the
 * browser's `confirm()`. Cancel has the focus, so Enter or Escape does nothing.
 */
import { computed, nextTick, ref, watch } from 'vue'
import BaseModal from './BaseModal.vue'
import { useConfirmStore } from '../stores/confirm'

const store = useConfirmStore()
const question = computed(() => store.question)
const cancelButton = ref<HTMLButtonElement | null>(null)

watch(question, (value) => {
  if (value) void nextTick(() => cancelButton.value?.focus())
})
</script>

<template>
  <BaseModal
    v-if="question"
    :kicker="question.kicker"
    :title="question.title"
    width="460px"
    @close="store.answer(false)"
  >
    <p class="confirm__message">{{ question.message }}</p>

    <template #footer>
      <button ref="cancelButton" class="btn" @click="store.answer(false)">Cancel</button>
      <div class="confirm__spacer"></div>
      <button class="btn btn--danger" @click="store.answer(true)">{{ question.action }}</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.confirm__message {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.confirm__spacer {
  flex: 1;
}
</style>
