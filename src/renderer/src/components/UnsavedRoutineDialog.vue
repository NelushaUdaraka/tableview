<script setup lang="ts">
/**
 * Asked before a routine's tab closes with its changes unsaved — the
 * routine's half of what a table asks before its staged edits are thrown
 * away.
 *
 * Saving is running the tab's script, which is what writes a routine back.
 * When that fails the tab stays, and is put on screen with the error in its
 * results: it may not have been the tab being looked at when its ✕, or
 * Close all, was clicked.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import BaseModal from './BaseModal.vue'
import { diffLines, splitLines } from '../lib/lineDiff'
import { runQueryTab } from '../lib/runQueryTab'
import { useTabStore, type CloseReason, type QueryTab } from '../stores/tabs'

const tabs = useTabStore()
const saving = ref(false)

/** What is about to take the tab, as the prompt says it and as Save says it. */
const CAUSE: Record<CloseReason, { sentence: string; save: string }> = {
  close: { sentence: 'Closing the tab', save: 'Save and close' },
  disconnect: { sentence: 'Disconnecting', save: 'Save and disconnect' },
  'close-window': { sentence: 'Closing the window', save: 'Save and close' },
  quit: { sentence: 'Quitting', save: 'Save and quit' }
}

const cause = computed(() => CAUSE[tabs.closePrompt?.reason ?? 'close'])

const tab = computed(() => {
  const id = tabs.closePrompt?.tabId
  return (
    tabs.tabs.find((entry): entry is QueryTab => entry.id === id && entry.kind === 'query') ?? null
  )
})

const changes = computed(() => {
  const routine = tab.value?.routine
  if (!tab.value || !routine) return 0
  return diffLines(splitLines(routine.baseline), splitLines(tab.value.sql)).length
})

function answer(close: boolean): void {
  if (!saving.value) tabs.answerClose(close)
}

async function save(): Promise<void> {
  const current = tab.value
  if (!current || saving.value) return
  saving.value = true
  let saved = false
  try {
    saved = await runQueryTab(current.id)
  } finally {
    saving.value = false
  }
  tabs.answerClose(saved)
  // What went wrong has been said already; the tab's results say where.
  if (!saved) await tabs.select(current.id)
}

// A tab taken away while it waits — its connection closed under it — has
// nothing left to ask about.
watch(tab, (current) => {
  if (!current) answer(false)
})

// A dialog that goes away unanswered would leave its close waiting forever.
onBeforeUnmount(() => {
  if (tabs.closePrompt) tabs.answerClose(false)
})
</script>

<template>
  <BaseModal
    v-if="tab?.routine"
    kicker="Unsaved changes"
    title="This routine has changes"
    :subtitle="`${tab.routine.schema}.${tab.routine.name}`"
    width="480px"
    @close="answer(false)"
  >
    <p class="prompt__text">
      {{ changes === 1 ? '1 change has' : `${changes} changes have` }} not been saved to the
      database. {{ cause.sentence }} would discard {{ changes === 1 ? 'it' : 'them' }}.
    </p>
    <p class="prompt__text prompt__text--note">
      Saving runs the script in this tab: its <span class="mono">CREATE OR ALTER</span> replaces
      the routine on the server.
    </p>

    <template #footer>
      <button class="btn" :disabled="saving" @click="answer(false)">Cancel</button>
      <div class="prompt__spacer"></div>
      <button class="btn btn--danger" :disabled="saving" @click="answer(true)">Discard</button>
      <button class="btn btn--primary" :disabled="saving" @click="save">
        <span v-if="saving" class="spinner"></span>
        {{ cause.save }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.prompt__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.prompt__text--note {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-muted);
}
.prompt__spacer {
  flex: 1;
}
</style>
