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
    title: 'Tabs',
    items: [
      ['Ctrl+T', 'New query tab'],
      ['Ctrl+W', 'Close tab'],
      ['Ctrl+Tab', 'Next tab'],
      ['Ctrl+Shift+Tab', 'Previous tab']
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
      ['Shift+click a header', 'Add a secondary sort']
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
</script>

<template>
  <BaseModal kicker="Help" title="Keyboard shortcuts" width="560px" flush @close="$emit('close')">
    <div class="shortcuts">
      <section v-for="group in GROUPS" :key="group.title">
        <h3 class="shortcuts__title">{{ group.title }}</h3>
        <div v-for="[keys, description] in group.items" :key="keys" class="shortcuts__row">
          <span class="shortcuts__label">{{ description }}</span>
          <kbd>{{ keys }}</kbd>
        </div>
      </section>
    </div>
    <template #footer>
      <button class="btn btn--primary" @click="$emit('close')">Close</button>
    </template>
  </BaseModal>
</template>

<style scoped>
/* One ruled list: the label reads first, the keys sit at the right edge. */
.shortcuts {
  max-height: 340px;
  overflow-y: auto;
}
.shortcuts__title {
  margin: 0;
  padding: 12px 20px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-app);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent);
}
.shortcuts__row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 9px 20px;
  border-bottom: 1px solid var(--border);
}
.shortcuts__label {
  flex: 1;
  font-size: 13px;
}
kbd {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
</style>
