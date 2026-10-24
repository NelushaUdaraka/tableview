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
 */
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import BaseModal from './BaseModal.vue'
import { namesIt } from '../lib/confirmWrites'
import { useConfirmWritesStore } from '../stores/confirmWrites'

const store = useConfirmWritesStore()
const question = computed(() => store.question)
const cancelButton = ref<HTMLButtonElement | null>(null)
/** What has been typed for each item that wants its name, by index. */
const typed = ref<Record<number, string>>({})

watch(question, (value) => {
  typed.value = {}
  if (value) void nextTick(() => cancelButton.value?.focus())
})

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
    kicker="Confirm writes"
    :title="question.title"
    :subtitle="question.connection"
    width="600px"
    @close="store.answer(false)"
  >
    <p class="writes__lead">
      {{ question.items.length === 1 ? 'This changes' : 'These change' }} the database on
      <span class="mono">{{ question.server }}</span>. Nothing is sent until you say so.
    </p>

    <ol class="writes" aria-label="What would change">
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
      <button class="btn btn--danger" :disabled="!ready" @click="go">
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
