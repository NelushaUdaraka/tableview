<script setup lang="ts">
/**
 * Adding, editing and deleting snippets, and passing them between machines.
 *
 * The dialog edits a copy of the list and saves it whole, so a half-made
 * snippet never reaches the editor's completion, and Cancel leaves the list
 * as it was. Import and export work on the saved list, so they wait for
 * unsaved edits to be saved or dropped.
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import BaseModal from './BaseModal.vue'
import type { Snippet } from '@shared/types'
import { missingStarters, snippetPreview, snippetProblem } from '@shared/snippets'
import { useConfirmStore } from '../stores/confirm'
import { useSnippetStore } from '../stores/snippets'
import { useToastStore } from '../stores/toasts'

const emit = defineEmits<{ (event: 'close'): void }>()

const store = useSnippetStore()
const confirm = useConfirmStore()
const toasts = useToastStore()

const draft = ref<Snippet[]>([])
const selectedId = ref<string | null>(null)
const saving = ref(false)
/** Set by a Save that was turned down, so the problem shows on the snippet it is about. */
const showProblems = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)

let added = 0
/** Unique within the list, which is all an id has to be. */
const newId = (): string => `snippet-${Date.now().toString(36)}-${(added += 1)}`

const copy = (list: readonly Snippet[]): Snippet[] => list.map((snippet) => ({ ...snippet }))

onMounted(async () => {
  try {
    await store.load()
  } catch (error) {
    toasts.fromError('Could not read the snippets', error)
  }
  draft.value = copy(store.snippets)
  selectedId.value = draft.value[0]?.id ?? null
})

const selected = computed(() => draft.value.find((s) => s.id === selectedId.value) ?? null)

const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(store.snippets))

const problems = computed(() => {
  const out = new Map<string, string>()
  for (const snippet of draft.value) {
    const problem = snippetProblem(snippet, draft.value)
    if (problem) out.set(snippet.id, problem)
  }
  return out
})

const selectedProblem = computed(() =>
  showProblems.value && selected.value ? (problems.value.get(selected.value.id) ?? null) : null
)

const starters = computed(() => missingStarters(draft.value))

function select(id: string): void {
  selectedId.value = id
}

async function add(): Promise<void> {
  const snippet: Snippet = { id: newId(), name: 'New snippet', prefix: '', body: '' }
  draft.value.push(snippet)
  selectedId.value = snippet.id
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}

function remove(id: string): void {
  const index = draft.value.findIndex((s) => s.id === id)
  if (index < 0) return
  draft.value.splice(index, 1)
  selectedId.value = draft.value[Math.min(index, draft.value.length - 1)]?.id ?? null
}

function restoreStarters(): void {
  const restored = copy(starters.value)
  draft.value.push(...restored)
  selectedId.value = restored[0]?.id ?? selectedId.value
}

async function save(): Promise<void> {
  const firstProblem = draft.value.find((s) => problems.value.has(s.id))
  if (firstProblem) {
    showProblems.value = true
    selectedId.value = firstProblem.id
    return
  }
  saving.value = true
  try {
    await store.save(draft.value)
    toasts.success('Snippets saved')
    emit('close')
  } catch (error) {
    toasts.fromError('Could not save the snippets', error)
  } finally {
    saving.value = false
  }
}

async function close(): Promise<void> {
  if (dirty.value) {
    const discard = await confirm.ask({
      kicker: 'Snippets',
      title: 'Discard your changes?',
      message: 'The snippets you added or edited here have not been saved.',
      action: 'Discard'
    })
    if (!discard) return
  }
  emit('close')
}

async function exportFile(): Promise<void> {
  try {
    const result = await store.exportFile()
    if (result) toasts.success(`Exported ${result.count} snippet${result.count === 1 ? '' : 's'}`)
  } catch (error) {
    toasts.fromError('Could not export the snippets', error)
  }
}

async function importFile(): Promise<void> {
  try {
    const summary = await store.importFile()
    if (!summary) return
    draft.value = copy(store.snippets)
    const added = summary.added.length
    const replaced = summary.replaced.length
    if (added + replaced === 0) {
      toasts.info('That file held no snippets to import')
    } else {
      const parts = [
        added ? `${added} added` : '',
        replaced ? `${replaced} replaced (${summary.replaced.join(', ')})` : ''
      ].filter(Boolean)
      toasts.success(`Snippets imported: ${parts.join(', ')}`)
    }
    const first = draft.value.find((s) => s.prefix === summary.added[0] || s.prefix === summary.replaced[0])
    if (first) selectedId.value = first.id
  } catch (error) {
    toasts.fromError('Could not import the snippets', error)
  }
}
</script>

<template>
  <BaseModal kicker="Editor" title="Snippets" width="860px" flush @close="close">
    <div class="snippets">
      <div class="snippets__list" role="listbox" aria-label="Snippets">
        <button
          v-for="snippet in draft"
          :key="snippet.id"
          class="snippets__item"
          :class="{
            'snippets__item--on': snippet.id === selectedId,
            'snippets__item--bad': showProblems && problems.has(snippet.id)
          }"
          role="option"
          :aria-selected="snippet.id === selectedId"
          @click="select(snippet.id)"
        >
          <span class="snippets__name truncate">{{ snippet.name || 'Untitled' }}</span>
          <span class="snippets__prefix mono">{{ snippet.prefix }}</span>
        </button>
        <div v-if="draft.length === 0" class="snippets__none muted">No snippets yet</div>
        <div class="snippets__list-foot">
          <button class="btn btn--sm" @click="add">
            <AppIcon name="plus" :size="14" />
            New snippet
          </button>
          <button
            v-if="starters.length"
            class="btn btn--sm btn--ghost"
            :title="starters.map((s) => s.prefix).join(', ')"
            @click="restoreStarters"
          >
            Restore starters
          </button>
        </div>
      </div>

      <div v-if="selected" class="snippets__edit">
        <div class="snippets__row">
          <label class="field snippets__grow">
            <span class="field__label">Name</span>
            <input ref="nameInput" v-model="selected.name" class="input" spellcheck="false" />
          </label>
          <label class="field snippets__prefix-field">
            <span class="field__label">Prefix</span>
            <input
              v-model="selected.prefix"
              class="input mono"
              spellcheck="false"
              autocomplete="off"
              placeholder="tran"
            />
          </label>
        </div>
        <label class="field">
          <span class="field__label">Description</span>
          <input
            v-model="selected.description"
            class="input"
            placeholder="Optional — shown beside the snippet in completion"
          />
        </label>
        <label class="field">
          <span class="field__label">Text</span>
          <textarea
            v-model="selected.body"
            class="textarea snippets__body"
            rows="8"
            spellcheck="false"
            wrap="off"
          ></textarea>
          <span class="field__hint">
            Type the prefix in a query and pick the snippet from completion. Mark the places to fill
            in as <code class="mono">${1:name}</code>, <code class="mono">${2:value}</code>…; Tab moves
            from one to the next, the same number twice is edited in both places at once, and
            <code class="mono">${0}</code> is where the cursor ends up.
          </span>
        </label>
        <p v-if="selectedProblem" class="snippets__problem" role="alert">
          <AppIcon name="triangle-alert" :size="14" />
          {{ selectedProblem }}
        </p>
        <div class="snippets__preview">
          <span class="caps">Inserts</span>
          <pre class="mono">{{ snippetPreview(selected.body) || ' ' }}</pre>
        </div>
        <div class="snippets__edit-foot">
          <button class="btn btn--sm btn--danger" @click="remove(selected.id)">
            <AppIcon name="trash" :size="14" />
            Delete
          </button>
        </div>
      </div>
      <div v-else class="snippets__edit snippets__empty muted">
        Add a snippet, or restore the starter set.
      </div>
    </div>

    <template #footer>
      <button
        class="btn btn--muted"
        :disabled="dirty"
        :title="dirty ? 'Save or cancel your changes first' : 'Add the snippets in a file to this list'"
        @click="importFile"
      >
        <AppIcon name="upload" :size="14" />
        Import…
      </button>
      <button
        class="btn btn--muted"
        :disabled="dirty || store.snippets.length === 0"
        :title="dirty ? 'Save or cancel your changes first' : 'Write this list to a file to share'"
        @click="exportFile"
      >
        <AppIcon name="download" :size="14" />
        Export…
      </button>
      <div class="snippets__spacer"></div>
      <button class="btn btn--muted" @click="close">Cancel</button>
      <button class="btn btn--primary" :disabled="saving || !dirty" @click="save">
        <span v-if="saving" class="spinner"></span>
        Save
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.snippets {
  display: flex;
  height: min(600px, 66vh);
  min-height: 0;
}
.snippets__list {
  display: flex;
  flex-direction: column;
  width: 260px;
  flex: 0 0 auto;
  padding: 8px 6px;
  border-right: 1px solid var(--border-subtle);
  overflow-y: auto;
}
.snippets__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 6px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--transition);
}
.snippets__item:hover {
  background: var(--bg-hover-strong);
}
.snippets__item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-ring);
}
.snippets__item--on,
.snippets__item--on:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}
.snippets__item--bad .snippets__name {
  color: var(--danger);
}
.snippets__name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
.snippets__prefix {
  font-size: 11px;
  color: var(--text-muted);
}
.snippets__none {
  padding: 10px;
  font-size: 12px;
}
.snippets__list-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: auto;
  padding: 10px 4px 2px;
}
.snippets__edit {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-width: 0;
  padding: 16px 20px;
  overflow-y: auto;
}
.snippets__empty {
  align-items: center;
  justify-content: center;
  font-size: 13px;
}
.snippets__row {
  display: flex;
  gap: 12px;
}
.snippets__grow {
  flex: 1;
}
.snippets__prefix-field {
  width: 160px;
}
.snippets__body {
  min-height: 120px;
  white-space: pre;
  tab-size: 4;
}
.field__hint code {
  font-size: 11px;
  color: var(--text-secondary);
}
.snippets__problem {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
.snippets__preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.snippets__preview pre {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  user-select: text;
}
.snippets__edit-foot {
  display: flex;
}
.snippets__spacer {
  flex: 1;
}
</style>
