<script setup lang="ts">
/**
 * A JSON value, drawn as a tree.
 *
 * One line per entry, containers opening into another of these — the component
 * renders the *contents* of the value it is given, so nesting is the same
 * component one level in. Which is why the rows carry their own open state:
 * each level answers for what is under it, and nothing has to hold a map of
 * paths through a document whose shape it does not know.
 */
import { computed, ref } from 'vue'
import {
  DEFAULT_OPEN_DEPTH,
  entriesOf,
  isContainer,
  kindOf,
  previewOf,
  scalarText,
  type JsonValue
} from '../lib/jsonCell'

const props = withDefaults(defineProps<{ value: JsonValue; depth?: number }>(), { depth: 0 })

const entries = computed(() => entriesOf(props.value))

/** Only the rows that have been clicked; the rest go by depth. */
const toggled = ref<Record<string, boolean>>({})

function isOpen(key: string): boolean {
  return toggled.value[key] ?? props.depth < DEFAULT_OPEN_DEPTH
}

function toggle(key: string): void {
  toggled.value = { ...toggled.value, [key]: !isOpen(key) }
}
</script>

<template>
  <div class="json" :class="{ 'json--nested': depth > 0 }">
    <template v-for="entry in entries" :key="entry.key">
      <template v-if="isContainer(entry.value)">
        <button class="json__row json__row--branch" @click="toggle(entry.key)">
          <span class="json__chevron">{{ isOpen(entry.key) ? '▾' : '▸' }}</span>
          <span class="json__key truncate">{{ entry.key }}</span>
          <span class="json__preview">{{ previewOf(entry.value) }}</span>
        </button>
        <JsonTree v-if="isOpen(entry.key)" :value="entry.value" :depth="depth + 1" />
      </template>

      <div v-else class="json__row">
        <span class="json__chevron"></span>
        <span class="json__key truncate">{{ entry.key }}</span>
        <span class="json__value" :class="`json__value--${kindOf(entry.value)}`">
          {{ scalarText(entry.value) }}
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.json {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 17px;
}
/* Each level is one indent and one rule, so a deep document still reads as a
   set of nested blocks rather than as a wall of leading space. */
.json--nested {
  margin-left: 7px;
  padding-left: 8px;
  border-left: 1px solid var(--border-subtle);
}

.json__row {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  width: 100%;
  padding: 1px 2px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  text-align: left;
}
.json__row--branch {
  cursor: pointer;
}
.json__row--branch:hover {
  background: var(--bg-hover);
}
.json__chevron {
  flex: 0 0 auto;
  width: 8px;
  color: var(--text-muted);
  font-size: 8px;
  /* Line the glyph up with the text beside it rather than the top of the row. */
  line-height: 17px;
}
.json__key {
  flex: 0 0 auto;
  max-width: 45%;
  color: var(--text-primary);
}
.json__key::after {
  content: ':';
  color: var(--text-muted);
}
.json__preview {
  color: var(--text-muted);
}
.json__value {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
/* The editor holds its keywords apart from everything else and leaves the rest
   in the text shades; `true`, `false` and `null` are this document's. */
.json__value--boolean,
.json__value--null {
  color: var(--accent-bright);
}
.json__value--number {
  color: var(--text-primary);
}
</style>
