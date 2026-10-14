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
import AppIcon from './AppIcon.vue'
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
          <AppIcon
            class="json__chevron"
            :class="{ 'json__chevron--open': isOpen(entry.key) }"
            name="chevron-right"
            :size="10"
          />
          <span class="json__key truncate">{{ entry.key }}</span>
          <span class="json__preview">{{ previewOf(entry.value) }}</span>
        </button>
        <JsonTree v-if="isOpen(entry.key)" :value="entry.value" :depth="depth + 1" />
      </template>

      <div v-else class="json__row">
        <span class="json__chevron json__chevron--blank"></span>
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
  border-radius: var(--radius-xs);
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
  background: var(--bg-hover-strong);
}
/* Lined up with the first line of the text beside it, and turned a quarter
   when the branch is open. */
.json__chevron {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  margin-top: 3.5px;
  color: var(--text-muted);
  transition: transform var(--transition);
}
.json__chevron--open {
  transform: rotate(90deg);
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
/* The editor's own syntax colours, so a document reads the way the SQL
   around it does: strings, numbers, and `true`, `false` and `null` as keywords. */
.json__value--string {
  color: var(--syntax-string);
}
.json__value--boolean,
.json__value--null {
  color: var(--syntax-keyword);
}
.json__value--number {
  color: var(--syntax-number);
}
</style>
