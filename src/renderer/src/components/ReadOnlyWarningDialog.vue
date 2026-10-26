<script setup lang="ts">
/**
 * The question asked before a connection may write freely again — coming off
 * read-only, or no longer confirming its writes.
 *
 * Whichever switch raised it — the status bar, the list, the form — the
 * answer is the same: a connection that was guarded on purpose is about to
 * accept edits, truncate, drop and whatever is run in it, without asking. The
 * safe answer has the focus, so Enter or Escape keeps the guard on; only the
 * button that says so takes it off.
 */
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import BaseModal from './BaseModal.vue'
import { useReadOnlyStore } from '../stores/readOnly'

const readOnly = useReadOnlyStore()
const prompt = computed(() => readOnly.prompt)
const keepButton = ref<HTMLButtonElement | null>(null)

watch(prompt, (value) => {
  if (value) void nextTick(() => keepButton.value?.focus())
})

/** Where the writes would go, the way the connection list shows it. */
/** Which guard is coming off, in the words of its switch. */
const wording = computed(() =>
  prompt.value?.from === 'confirm'
    ? {
        kicker: 'Confirm writes',
        title: 'Stop confirming writes?',
        keep: 'Keep confirming',
        drop: 'Stop confirming',
        again: 'Turn confirm writes back on when you are done.'
      }
    : {
        kicker: 'Read-only',
        title: 'Turn off read-only?',
        keep: 'Keep read-only',
        drop: 'Turn off read-only',
        again: 'Turn read-only back on when you are done.'
      }
)

const target = computed(() => {
  const connection = prompt.value?.connection
  if (!connection) return ''
  const database = connection.database ? ` / ${connection.database}` : ''
  return `${connection.host}:${connection.port}${database}`
})
</script>

<template>
  <BaseModal
    v-if="prompt"
    :kicker="wording.kicker"
    :title="wording.title"
    :subtitle="prompt.connection.name"
    width="500px"
    @close="readOnly.answer(false)"
  >
    <div class="writable">
      <AppIcon class="writable__icon" name="triangle-alert" :size="18" />
      <div class="writable__text">
        <p>
          “{{ prompt.connection.name }}” will accept changes again without asking: table edits,
          truncate and drop, and any statement you run, against
          <span class="mono">{{ target }}</span>.
        </p>
        <p class="writable__note">
          The setting is saved with the connection and changes at once in every window that has
          it open. {{ wording.again }}
        </p>
      </div>
    </div>

    <template #footer>
      <button ref="keepButton" class="btn" @click="readOnly.answer(false)">
        {{ wording.keep }}
      </button>
      <div class="writable__spacer"></div>
      <button class="btn btn--danger" @click="readOnly.answer(true)">{{ wording.drop }}</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.writable {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.writable__icon {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--warning);
}
.writable__text p {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.writable__text .mono {
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.writable__text .writable__note {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-muted);
}
.writable__spacer {
  flex: 1;
}
</style>
