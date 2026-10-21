<script setup lang="ts">
/**
 * Asked before a query tab's open transaction would end with its session: the
 * tab closing or moving to another window, disconnecting, closing the window,
 * quitting.
 *
 * Committing and rolling back are runs of the tab, as its own toolbar buttons
 * are, so what they did shows in its results and its history. A commit that
 * fails keeps the tab and puts it on screen with the error: it may not have
 * been the tab being looked at when its ✕, or Close all, was clicked.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { COMMIT_SQL, ROLLBACK_SQL, transactionOpen } from '@shared/sessions'
import BaseModal from './BaseModal.vue'
import { runQueryTab } from '../lib/runQueryTab'
import { stopRun } from '../lib/tabSessions'
import { useTabStore, type QueryTab, type TransactionReason } from '../stores/tabs'

const tabs = useTabStore()
const working = ref(false)
const cancelButton = ref<HTMLButtonElement | null>(null)

/** What is about to end the session, as the question says it and as its buttons do. */
const CAUSE: Record<TransactionReason, { sentence: string; verb: string }> = {
  close: { sentence: 'Closing the tab', verb: 'close' },
  move: { sentence: 'Moving the tab to another window', verb: 'move' },
  disconnect: { sentence: 'Disconnecting', verb: 'disconnect' },
  'close-window': { sentence: 'Closing the window', verb: 'close' },
  quit: { sentence: 'Quitting', verb: 'quit' }
}

const prompt = computed(() => tabs.transactionPrompt)
const cause = computed(() => CAUSE[prompt.value?.reason ?? 'close'])

function queryTab(id: string | undefined): QueryTab | null {
  return (
    tabs.tabs.find((entry): entry is QueryTab => entry.id === id && entry.kind === 'query') ?? null
  )
}

const tab = computed(() => queryTab(prompt.value?.tabId))

const subtitle = computed(() => {
  const current = tab.value
  if (!current) return ''
  return current.session?.database ? `${current.title} · ${current.session.database}` : current.title
})

function answer(proceed: boolean): void {
  if (!working.value) tabs.answerTransaction(proceed)
}

async function commit(): Promise<void> {
  const current = tab.value
  if (!current || working.value) return
  working.value = true
  let committed = false
  try {
    await runQueryTab(current.id, COMMIT_SQL)
    const after = queryTab(current.id)
    committed =
      after !== null &&
      !transactionOpen(after.session) &&
      !after.result?.statements.some((statement) => statement.error)
  } finally {
    working.value = false
  }
  tabs.answerTransaction(committed)
  // What went wrong has been said already; the tab's results say where.
  if (!committed) await tabs.select(current.id)
}

/** Rolls back — stopping the query first when one is running — and lets the session end. */
async function rollBack(): Promise<void> {
  const current = tab.value
  if (!current || working.value) return
  working.value = true
  try {
    if (prompt.value?.running) {
      await stopRun(current, () => queryTab(current.id)?.running === true)
    }
    await runQueryTab(current.id, ROLLBACK_SQL)
  } finally {
    working.value = false
  }
  // Ending the session rolls back whatever this did not.
  tabs.answerTransaction(true)
}

// A tab taken away while it waits — its connection closed under it — has
// nothing left to ask about.
watch(tab, (current) => {
  if (!current) answer(false)
})

// Cancel is where the focus starts: Enter or Escape keeps everything as it was.
onMounted(() => cancelButton.value?.focus())

// A dialog that goes away unanswered would leave its close waiting forever.
onBeforeUnmount(() => {
  if (tabs.transactionPrompt) tabs.answerTransaction(false)
})
</script>

<template>
  <BaseModal
    v-if="tab && prompt"
    kicker="Open transaction"
    :title="
      prompt.running
        ? 'This tab\'s query is running inside a transaction'
        : 'This tab has a transaction open'
    "
    :subtitle="subtitle"
    width="480px"
    @close="answer(false)"
  >
    <p class="prompt__text">
      {{ prompt.stopped ? 'Its query was stopped part-way. ' : '' }}{{ cause.sentence }} would end
      the session, and with it the transaction.
    </p>
    <p v-if="prompt.running" class="prompt__text prompt__text--note">
      Its query has to stop first: nothing can be committed while it runs.
    </p>

    <template #footer>
      <button ref="cancelButton" class="btn" :disabled="working" @click="answer(false)">
        Cancel
      </button>
      <div class="prompt__spacer"></div>
      <button v-if="prompt.running" class="btn btn--danger" :disabled="working" @click="rollBack">
        <span v-if="working" class="spinner"></span>
        Stop and roll back
      </button>
      <template v-else>
        <button class="btn btn--danger" :disabled="working" @click="rollBack">
          Roll back and {{ cause.verb }}
        </button>
        <button class="btn btn--primary" :disabled="working" @click="commit">
          <span v-if="working" class="spinner"></span>
          Commit and {{ cause.verb }}
        </button>
      </template>
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
