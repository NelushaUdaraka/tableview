<script setup lang="ts">
/**
 * Quick open (`Ctrl+P`): type part of a name, pick one, Enter.
 *
 * It hangs from the top of the window like a command palette rather than
 * sitting in the middle like a dialog — it is a place to type, and the list
 * grows down from it. Escape closes it through the modal stack, so it is the
 * one dialog Escape belongs to while it is open.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import type { IconName } from '../lib/icons'
import { closeModal, isTopModal, openModal } from '../lib/modalStack'
import {
  quickOpenItems,
  rankQuickOpen,
  type QuickOpenItem,
  type QuickOpenKind,
  type QuickOpenMatch
} from '../lib/quickOpen'
import { useLibraryStore } from '../stores/library'
import { useSchemaStore } from '../stores/schema'

const props = defineProps<{
  /** Keys of what was opened lately, most recent first. */
  recent: string[]
}>()

const emit = defineEmits<{
  (event: 'open', item: QuickOpenItem, structure: boolean): void
  (event: 'close'): void
}>()

const schema = useSchemaStore()
const library = useLibraryStore()

const query = ref('')
const highlighted = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const items = computed(() =>
  quickOpenItems(schema.objects, schema.routines, library.savedQueries, schema.pinned)
)
const matches = computed(() => rankQuickOpen(items.value, query.value, props.recent))

watch(query, () => {
  highlighted.value = 0
  if (list.value) list.value.scrollTop = 0
})

const ICONS: Record<QuickOpenKind, IconName> = {
  table: 'table',
  view: 'view',
  procedure: 'procedure',
  function: 'function',
  query: 'terminal'
}

const KIND_LABELS: Record<QuickOpenKind, string> = {
  table: 'Table',
  view: 'View',
  procedure: 'Procedure',
  function: 'Function',
  query: 'Saved query'
}

/** A name in pieces, the matched characters marked, for drawing them stronger. */
function pieces(text: string, positions: number[]): { text: string; hit: boolean }[] {
  if (positions.length === 0) return [{ text, hit: false }]
  const hits = new Set(positions)
  const out: { text: string; hit: boolean }[] = []
  for (let index = 0; index < text.length; index += 1) {
    const hit = hits.has(index)
    const last = out[out.length - 1]
    if (last && last.hit === hit) last.text += text[index]
    else out.push({ text: text[index], hit })
  }
  return out
}

function formatCount(value?: number): string {
  if (value === undefined || value === null) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M rows`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k rows`
  return `${value} ${value === 1 ? 'row' : 'rows'}`
}

/** Whether a modifier turns Enter into "open its structure". */
function canOpenStructure(match: QuickOpenMatch | undefined): boolean {
  return match?.item.kind === 'table' || match?.item.kind === 'view'
}

function open(index: number, structure = false): void {
  const match = matches.value[index]
  if (!match) return
  emit('open', match.item, structure && canOpenStructure(match))
}

function move(delta: number): void {
  const count = matches.value.length
  if (count === 0) return
  highlighted.value = (highlighted.value + delta + count) % count
  void nextTick(() => {
    list.value
      ?.querySelector<HTMLElement>(`[data-index="${highlighted.value}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function onInputKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'PageDown':
      event.preventDefault()
      move(Math.min(8, matches.value.length - 1 - highlighted.value) || 0)
      break
    case 'PageUp':
      event.preventDefault()
      move(-Math.min(8, highlighted.value))
      break
    case 'Enter':
      event.preventDefault()
      open(highlighted.value, event.shiftKey || event.ctrlKey || event.metaKey)
      break
  }
}

/** This palette's place in the stack, so Escape closes only the one on top. */
let place: symbol | null = null

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !place || !isTopModal(place)) return
  event.stopPropagation()
  emit('close')
}

onMounted(() => {
  place = openModal()
  document.addEventListener('keydown', onKeydown, true)
  // Saved queries are read when the sidebar's panel opens; a window with no
  // sidebar, or one that never looked, reads them now.
  if (library.savedQueries.length === 0) void library.loadSavedQueries().catch(() => undefined)
  void nextTick(() => input.value?.focus())
})

onBeforeUnmount(() => {
  if (place) closeModal(place)
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div class="quick-backdrop" @mousedown.self="emit('close')">
    <div class="quick" role="dialog" aria-modal="true" aria-label="Quick open">
      <div class="quick__field">
        <AppIcon class="quick__glyph" name="search" :size="15" />
        <input
          ref="input"
          v-model="query"
          class="quick__input"
          placeholder="Open a table, view, routine or saved query…"
          spellcheck="false"
          autocomplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-open-list"
          :aria-activedescendant="matches.length ? `quick-open-${highlighted}` : undefined"
          @keydown="onInputKeydown"
        />
      </div>

      <div v-if="matches.length" id="quick-open-list" ref="list" class="quick__list" role="listbox">
        <div
          v-for="(match, index) in matches"
          :id="`quick-open-${index}`"
          :key="match.item.key"
          class="quick__item"
          :class="{ 'quick__item--on': index === highlighted }"
          role="option"
          :aria-selected="index === highlighted"
          :data-index="index"
          :title="match.item.schema ? `${KIND_LABELS[match.item.kind]} ${match.item.schema}.${match.item.name}` : `${KIND_LABELS[match.item.kind]} ${match.item.name}`"
          @mousemove="highlighted = index"
          @mousedown.prevent
          @click="open(index, $event.shiftKey || $event.ctrlKey || $event.metaKey)"
        >
          <AppIcon
            class="quick__icon"
            :class="`quick__icon--${match.item.kind}`"
            :name="ICONS[match.item.kind]"
            :size="14"
          />
          <span class="quick__name truncate">
            <span
              v-for="(piece, at) in pieces(match.item.name, match.namePositions)"
              :key="at"
              :class="{ quick__hit: piece.hit }"
              >{{ piece.text }}</span
            >
          </span>
          <span v-if="match.item.schema" class="quick__schema mono truncate">
            <span
              v-for="(piece, at) in pieces(match.item.schema, match.schemaPositions)"
              :key="at"
              :class="{ quick__hit: piece.hit }"
              >{{ piece.text }}</span
            >
          </span>
          <span v-else class="quick__schema">{{ KIND_LABELS[match.item.kind] }}</span>
          <AppIcon v-if="match.item.pinned" class="quick__pin" name="star" :size="12" />
          <span class="quick__count num">{{ formatCount(match.item.rowCountEstimate) }}</span>
        </div>
      </div>
      <div v-else class="quick__empty">
        {{ items.length === 0 ? 'The schema is still being read' : 'Nothing by that name' }}
      </div>

      <div class="quick__foot">
        <span
          ><kbd><AppIcon name="arrow-up" :size="10" /></kbd
          ><kbd><AppIcon name="arrow-down" :size="10" /></kbd> to move</span
        >
        <span><kbd>Enter</kbd> to open</span>
        <span><kbd>Shift</kbd>+<kbd>Enter</kbd> a table’s structure</span>
        <span><kbd>Esc</kbd> to close</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quick-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 72px 16px 16px;
  background: color-mix(in srgb, var(--scrim) 55%, transparent);
  z-index: 100;
  animation: fade-in var(--duration) var(--ease);
}
.quick {
  display: flex;
  flex-direction: column;
  width: 600px;
  max-width: 100%;
  max-height: min(560px, calc(100vh - 120px));
  border: 1px solid var(--border-overlay);
  border-radius: var(--radius-lg);
  background: var(--bg-overlay);
  box-shadow: var(--shadow);
  overflow: hidden;
  animation: dialog-in var(--duration-slow) var(--ease-out);
}
.quick__field {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-subtle);
  flex: 0 0 auto;
}
.quick__glyph {
  color: var(--text-muted);
  flex: 0 0 auto;
}
.quick__input {
  flex: 1;
  min-width: 0;
  height: 46px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: 14px;
}
.quick__input::placeholder {
  color: var(--text-muted);
}
.quick__list {
  flex: 1;
  min-height: 0;
  padding: 6px;
  overflow-y: auto;
}
.quick__item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
}
.quick__item--on {
  background: var(--accent-soft);
  color: var(--text-primary);
}
.quick__icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}
.quick__item--on .quick__icon {
  color: var(--accent-fg);
}
.quick__name {
  flex: 0 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
}
.quick__schema {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.quick__hit {
  color: var(--accent-fg);
  font-weight: 600;
}
.quick__pin {
  flex: 0 0 auto;
  color: var(--key);
}
.quick__count {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.quick__empty {
  padding: 18px 16px;
  font-size: 13px;
  color: var(--text-muted);
}
.quick__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 8px 14px;
  border-top: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-app) 55%, var(--bg-overlay));
  font-size: 11px;
  color: var(--text-muted);
  flex: 0 0 auto;
}
.quick__foot kbd {
  margin: 0 1px;
}
</style>
