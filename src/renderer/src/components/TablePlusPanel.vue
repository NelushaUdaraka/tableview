<script setup lang="ts">
/**
 * The paste that brings a connection over from TablePlus.
 *
 * TablePlus hands a saved connection out as a URL — right-click it, Copy as
 * URL — so the panel says where to click, then takes the URL off the clipboard
 * through the main process, which hands over a SQL Server URL from TablePlus
 * and nothing else. What the paste found replaces the form; the line under
 * the panel says what came across, and anything that needs doing before Save.
 */
import { computed, ref } from 'vue'
import { parseTablePlusUrl, tablePlusStatus, type TablePlusImport } from '@shared/tableplus'
import AppIcon from './AppIcon.vue'
import { api } from '../lib/api'

const props = defineProps<{
  /** Start with the steps showing, as Import from TablePlus in the menus does. */
  open: boolean
  /** The form's name now, which the person may have changed since the paste. */
  name: string
  savedNames: readonly string[]
  keyFileChosen: boolean
}>()
const emit = defineEmits<{ (event: 'fill', value: TablePlusImport): void }>()

const unfolded = ref(props.open)
const pasting = ref(false)
/** Why the last paste did not happen. The form is left as it was. */
const pasteError = ref('')
const result = ref<TablePlusImport | null>(null)

const status = computed(() =>
  result.value
    ? tablePlusStatus(result.value, {
        name: props.name,
        savedNames: props.savedNames,
        keyFileChosen: props.keyFileChosen
      })
    : null
)

async function paste(): Promise<void> {
  pasting.value = true
  pasteError.value = ''
  try {
    const found = parseTablePlusUrl(await api.readTablePlusUrlFromClipboard())
    result.value = found
    emit('fill', found)
  } catch (error) {
    pasteError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pasting.value = false
  }
}
</script>

<template>
  <section class="tpanel" aria-label="Bring a connection over from TablePlus">
    <div class="tpanel__head">
      <div class="tpanel__intro">
        <template v-if="unfolded">
          <div class="tpanel__title">Bringing this over from TablePlus?</div>
          <ol class="tpanel__steps">
            <li>In TablePlus, right-click the connection in the start window.</li>
            <li>Choose <strong>Copy as URL</strong>.</li>
            <li>Come back and press Paste URL. Everything below fills itself in.</li>
          </ol>
        </template>
        <div v-else class="tpanel__line">
          <span>Coming from TablePlus? Paste its URL.</span>
          <button type="button" class="tpanel__toggle" aria-expanded="false" @click="unfolded = true">
            How?
          </button>
        </div>
      </div>
      <button type="button" class="btn btn--sm tpanel__paste" :disabled="pasting" @click="paste">
        <span v-if="pasting" class="spinner"></span>
        <AppIcon v-else name="clipboard-paste" :size="14" />
        Paste URL
      </button>
    </div>

    <!-- Polite, so a screen reader hears what the paste found without the
         focus leaving the button that did it. -->
    <p class="tpanel__status" :class="{ 'error-text': pasteError }" aria-live="polite">
      <template v-if="pasteError">{{ pasteError }}</template>
      <template v-else-if="status">
        <AppIcon class="tpanel__found" name="circle-check" :size="12" />
        {{ status.summary }}
      </template>
    </p>
    <ul v-if="!pasteError && status?.warnings.length" class="tpanel__warnings">
      <li v-for="warning in status.warnings" :key="warning">
        <AppIcon class="tpanel__mark" name="triangle-alert" :size="12" />
        <span>{{ warning }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.tpanel {
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--bg-raised);
}
.tpanel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.tpanel__intro {
  min-width: 0;
}
.tpanel__title {
  font-weight: 600;
}
.tpanel__steps {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.tpanel__steps strong {
  font-weight: 600;
  color: var(--text-primary);
}
.tpanel__line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: var(--h-control-sm);
  color: var(--text-secondary);
}
.tpanel__toggle {
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--accent-fg);
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.tpanel__toggle:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: 2px;
}
.tpanel__paste {
  flex: 0 0 auto;
}
.tpanel__status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
}
/* Nothing pasted yet: no line, and no gap where it would be. */
.tpanel__status:empty {
  margin: 0;
}
.tpanel__status.error-text {
  font-family: var(--font-ui);
  font-size: 12px;
  color: var(--danger);
}
.tpanel__found {
  flex: 0 0 auto;
  color: var(--success);
}
/* The text stays a readable grey on the raised ground; the mark says "warning". */
.tpanel__warnings {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
}
.tpanel__warnings li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.tpanel__mark {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--warning);
}
</style>
