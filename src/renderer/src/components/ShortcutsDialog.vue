<script setup lang="ts">
import BaseModal from './BaseModal.vue'

defineEmits<{ (event: 'close'): void }>()

const GROUPS = [
  {
    title: 'Query',
    items: [
      ['Ctrl+Enter', 'Run the whole editor'],
      ['Ctrl+Shift+Enter', 'Run the selection'],
      ['Ctrl+Alt+Enter', 'Run the statement under the cursor'],
      ['Escape', 'Cancel the running query'],
      ['Ctrl+Shift+F', 'Format SQL'],
      ['Ctrl+S', 'Save query'],
      ['Ctrl+O', 'Open a .sql file']
    ]
  },
  {
    title: 'Routine definitions',
    items: [
      ['Click a mark by the line numbers', 'See what the stored routine had there'],
      ['Alt+F5', 'Next change'],
      ['Shift+Alt+F5', 'Previous change'],
      ['Ctrl+Alt+Z', 'Revert the change at the cursor'],
      ['Escape', 'Close the change you are looking at']
    ]
  },
  {
    title: 'Tabs',
    items: [
      ['Ctrl+T', 'New query tab'],
      ['Ctrl+W', 'Close tab'],
      ['Ctrl+Tab', 'Next tab'],
      ['Ctrl+Shift+Tab', 'Previous tab'],
      ['Ctrl+\\', 'Show this tab beside the others'],
      ['Ctrl+Shift+\\', 'Close the split'],
      ['Drag a tab', 'Reorder, move to the other pane, or drop outside for a new window']
    ]
  },
  {
    title: 'Grid',
    items: [
      ['Arrows', 'Move between cells'],
      ['Enter / F2', 'Edit the cell'],
      ['Type anything', 'Start editing with that character'],
      ['Shift+Enter', 'New line inside the cell editor'],
      ['Tab', 'Commit and move to the next cell'],
      ['Escape', 'Cancel the edit'],
      ['Delete', 'Set the cell to NULL'],
      ['Ctrl+C', 'Copy the cell'],
      ['Ctrl+Shift+C', 'Copy the row'],
      ['Click the › arrow', 'Open the row a foreign key points at'],
      ['Double-click a divider', 'Fit the column to its contents'],
      ['Shift+click a header', 'Add a secondary sort'],
      ['Right-click a header', 'Sorting, filtering and column widths']
    ]
  },
  {
    title: 'App',
    items: [
      ['Ctrl+B', 'Toggle the sidebar'],
      ['Ctrl+I', 'Toggle the row panel'],
      ['Ctrl+F', 'Focus the filter box'],
      ['F5', 'Refresh the schema'],
      ['Ctrl+Shift+L', 'Toggle light / dark'],
      ['Ctrl+Shift+E', 'Export results'],
      ['Ctrl+/', 'This list']
    ]
  }
]

/**
 * A combination as the keys to press, one cap each — or null for a shortcut
 * that is an instruction in words rather than keys.
 */
function keysOf(combo: string): string[] | null {
  if (/\s/.test(combo)) return null
  return combo.split('+')
}
</script>

<template>
  <BaseModal kicker="Help" title="Keyboard shortcuts" width="560px" flush @close="$emit('close')">
    <div class="shortcuts">
      <section v-for="group in GROUPS" :key="group.title">
        <h3 class="shortcuts__title">{{ group.title }}</h3>
        <div v-for="[keys, description] in group.items" :key="keys" class="shortcuts__row">
          <span class="shortcuts__label">{{ description }}</span>
          <span v-if="keysOf(keys)" class="shortcuts__keys">
            <kbd v-for="key in keysOf(keys)" :key="key">{{ key }}</kbd>
          </span>
          <span v-else class="shortcuts__words">{{ keys }}</span>
        </div>
      </section>
    </div>
    <template #footer>
      <button class="btn btn--primary" @click="$emit('close')">Close</button>
    </template>
  </BaseModal>
</template>

<style scoped>
/* One list: the label reads first, the keys sit at the right edge as caps. */
.shortcuts {
  max-height: 420px;
  overflow-y: auto;
  padding-bottom: 8px;
}
.shortcuts__title {
  position: sticky;
  top: 0;
  z-index: 1;
  margin: 0;
  padding: 14px 20px 6px;
  background: var(--bg-overlay);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.shortcuts__row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 34px;
  margin: 0 8px;
  padding: 4px 12px;
  border-radius: var(--radius-sm);
}
.shortcuts__row:hover {
  background: var(--bg-hover);
}
.shortcuts__label {
  flex: 1;
  font-size: 13px;
  color: var(--text-secondary);
}
.shortcuts__keys {
  display: flex;
  gap: 4px;
  flex: 0 0 auto;
}
.shortcuts__words {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
