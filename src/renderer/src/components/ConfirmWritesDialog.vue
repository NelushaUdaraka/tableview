<script setup lang="ts">
/**
 * The question a confirm-writes connection asks before anything writes.
 *
 * It lists each statement that would change something — its line, what it
 * does, the database it does it in — and nothing runs until the button that
 * says so. Cancel has the focus, so Enter or Escape sends nothing. What cannot
 * be taken back — a drop, a truncate, an UPDATE or DELETE with no WHERE — also
 * wants its table's name typed before that button wakes up: a name has to be
 * read to be typed, where a button only has to be found.
 *
 * Staged table edits come with the statements themselves, values written in,
 * and a script of them to copy. Asked only because *Confirm before applying*
 * is on, that is an everyday question: the focus is on Apply, as it always was.
 */
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import BaseModal from './BaseModal.vue'
import SqlCode from './SqlCode.vue'
import { api } from '../lib/api'
import { namesIt } from '../lib/confirmWrites'
import { useConfirmWritesStore } from '../stores/confirmWrites'
import { useToastStore } from '../stores/toasts'

const store = useConfirmWritesStore()
const toasts = useToastStore()
const question = computed(() => store.question)
const cancelButton = ref<HTMLButtonElement | null>(null)
const actionButton = ref<HTMLButtonElement | null>(null)
/** What has been typed for each item that wants its name, by index. */
const typed = ref<Record<number, string>>({})

watch(question, (value) => {
  typed.value = {}
  if (!value) return
  void nextTick(() => (value.routine ? actionButton : cancelButton).value?.focus())
})

const statementCount = computed(() => question.value?.statements?.length ?? 0)

async function copyScript(): Promise<void> {
  const script = question.value?.script
  if (!script) return
  await api.copyToClipboard(script)
  toasts.info('Copied the script')
}

const dangerous = computed(() => question.value?.items.filter((item) => item.danger).length ?? 0)

/** Every name asked for has been typed. */
const ready = computed(() =>
  (question.value?.items ?? []).every(
    (item, index) => !item.danger || namesIt(typed.value[index] ?? '', item.danger.name)
  )
)

function go(): void {
  if (ready.value) store.answer(true)
}
</script>

<template>
  <BaseModal
    v-if="question"
    :kicker="question.kicker ?? 'Confirm writes'"
    :title="question.title"
    :subtitle="question.connection"
    width="600px"
    @close="store.answer(false)"
  >
    <p v-if="question.statements" class="writes__lead">
      {{ statementCount === 1 ? 'This statement runs' : `These ${statementCount} statements run` }}
      <template v-if="question.database">
        in <span class="mono">{{ question.database }}</span>
      </template>
      on <span class="mono">{{ question.server }}</span>, in one transaction: all of it lands or none
      of it does. Nothing is sent until you say so.
    </p>
    <p v-else class="writes__lead">
      {{ question.items.length === 1 ? 'This changes' : 'These change' }} the database on
      <span class="mono">{{ question.server }}</span>. Nothing is sent until you say so.
    </p>

    <template v-if="question.statements">
      <ol class="statements" aria-label="The statements, in the order they run">
        <li v-for="(statement, index) in question.statements" :key="index" class="statement">
          <span class="statement__number mono">{{ index + 1 }}</span>
          <pre class="statement__sql mono selectable"><SqlCode :sql="statement" /></pre>
        </li>
      </ol>
      <p class="statements__aside">
        Values are written in to read; Apply still sends them as parameters.
      </p>
    </template>

    <ol v-if="question.items.length > 0" class="writes" aria-label="What would change">
      <li
        v-for="(item, index) in question.items"
        :key="index"
        class="write"
        :class="{ 'write--danger': item.danger }"
      >
        <div class="write__head">
          <AppIcon
            class="write__icon"
            :name="item.danger ? 'triangle-alert' : 'database'"
            :size="13"
          />
          <span v-if="item.line" class="write__line mono">Line {{ item.line }}</span>
          <span class="write__what">{{ item.description }}</span>
          <span class="write__db mono" title="The database it changes">{{ item.database }}</span>
        </div>
        <template v-if="item.danger">
          <p class="write__danger">
            It {{ item.danger.reason }}. Type
            <span class="mono write__name">{{ item.danger.name }}</span> to run it.
          </p>
          <input
            v-model="typed[index]"
            class="input input--sm mono write__input"
            :class="{ 'write__input--ok': namesIt(typed[index] ?? '', item.danger.name) }"
            :aria-label="`Type ${item.danger.name} to confirm`"
            :placeholder="item.danger.name"
            spellcheck="false"
            autocomplete="off"
            @keydown.enter.prevent="go"
          />
        </template>
      </li>
    </ol>

    <p v-if="question.note" class="writes__note">{{ question.note }}</p>

    <template #footer>
      <button ref="cancelButton" class="btn" @click="store.answer(false)">Cancel</button>
      <div class="writes__spacer"></div>
      <span v-if="dangerous > 0 && !ready" class="writes__waiting">
        Type {{ dangerous === 1 ? 'the name' : 'each name' }} to go on
      </span>
      <button v-if="question.script" class="btn btn--muted" @click="copyScript">
        <AppIcon name="copy" :size="14" />
        Copy as script
      </button>
      <button
        ref="actionButton"
        class="btn"
        :class="question.routine ? 'btn--primary' : 'btn--danger'"
        :disabled="!ready"
        @click="go"
      >
        {{ question.action }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.writes__lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.writes__lead .mono {
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.writes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 46vh;
  overflow-y: auto;
}
.write {
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}
.write--danger {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border-subtle));
}
.write__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
}
.write__icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}
.write--danger .write__icon {
  color: var(--danger);
}
.write__line {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-muted);
}
.write__what {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
}
.write__db {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary);
}
.write__danger {
  margin: 6px 0 6px 21px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.write__name {
  color: var(--text-primary);
}
.write__input {
  width: calc(100% - 21px);
  margin-left: 21px;
}
.write__input--ok {
  border-color: color-mix(in srgb, var(--danger) 60%, var(--border-strong));
}
.statements {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 46vh;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--bg-input);
}
.statement {
  display: flex;
  gap: 10px;
  padding: 6px 12px;
}
.statement + .statement {
  border-top: 1px solid var(--border-subtle);
}
.statement__number {
  flex: 0 0 auto;
  min-width: 1.5em;
  font-size: 11px;
  line-height: 1.65;
  text-align: right;
  color: var(--text-muted);
}
.statement__sql {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.statements__aside {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
.writes__note {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}
.writes__spacer {
  flex: 1;
}
.writes__waiting {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
