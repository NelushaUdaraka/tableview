<script setup lang="ts">
import { ref } from 'vue'
import ContextMenu, { type MenuEntry } from './ContextMenu.vue'
import { useTabStore } from '../stores/tabs'

const emit = defineEmits<{ (event: 'new-query'): void }>()
const tabs = useTabStore()
const menu = ref<{ x: number; y: number; id: string } | null>(null)

const menuItems: MenuEntry[] = [
  { label: 'Close', action: 'close' },
  { label: 'Close others', action: 'close-others' },
  { label: 'Close all', action: 'close-all' }
]

function onMenuSelect(action: string): void {
  const id = menu.value?.id
  if (!id) return
  if (action === 'close') tabs.close(id)
  else if (action === 'close-others') tabs.closeOthers(id)
  else if (action === 'close-all') tabs.closeAll()
}

function icon(kind: string): string {
  return kind === 'query' ? '⌨' : '▤'
}

/** Middle-click closes, matching browser and editor conventions. */
function onAuxClick(event: MouseEvent, id: string): void {
  if (event.button === 1) {
    event.preventDefault()
    tabs.close(id)
  }
}
</script>

<template>
  <div class="tabbar">
    <div class="tabbar__scroll">
      <button
        v-for="tab in tabs.tabs"
        :key="tab.id"
        class="tab"
        :class="{ 'tab--active': tab.id === tabs.activeId }"
        :title="tab.kind === 'table' ? `${tab.schema}.${tab.table}` : tab.title"
        @click="tabs.select(tab.id)"
        @auxclick="onAuxClick($event, tab.id)"
        @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, id: tab.id }"
      >
        <span class="tab__icon">{{ icon(tab.kind) }}</span>
        <span class="tab__title truncate">{{ tab.title }}</span>
        <span v-if="tab.kind === 'query' && tab.running" class="spinner tab__spinner"></span>
        <span
          v-else-if="tab.kind === 'query' && tab.dirty"
          class="tab__dot"
          title="Unsaved changes"
        ></span>
        <span
          v-else-if="tab.kind === 'table' && tab.pendingEdits > 0"
          class="tab__dot tab__dot--edit"
          :title="`${tab.pendingEdits} pending change(s)`"
        ></span>
        <span class="tab__close" title="Close" @click.stop="tabs.close(tab.id)">✕</span>
      </button>
    </div>

    <button class="tabbar__new" title="New query (Ctrl+T)" @click="emit('new-query')">+</button>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @select="onMenuSelect"
      @close="menu = null"
    />
  </div>
</template>

<style scoped>
.tabbar {
  display: flex;
  align-items: stretch;
  height: var(--h-tabstrip);
  border-bottom: var(--rule) solid var(--border-strong);
  background: var(--bg-app);
  flex: 0 0 auto;
}
.tabbar__scroll {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
}
.tabbar__scroll::-webkit-scrollbar {
  height: 0;
}
.tab {
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: 220px;
  min-width: 132px;
  padding: 0 10px 0 14px;
  border: none;
  border-right: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.tab:hover {
  background: var(--bg-hover);
}
/* The active tab's accent sits on the top edge, so the strip reads as a set of
   cards standing on the panel rather than underlined labels. */
.tab--active {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: inset 0 2px 0 var(--accent);
}
.tab__icon {
  font-size: 11px;
  color: var(--text-muted);
}
.tab__title {
  flex: 1;
  min-width: 0;
  text-align: left;
}
.tab__spinner {
  width: 11px;
  height: 11px;
  border-width: 1.5px;
}
.tab__dot {
  width: 7px;
  height: 7px;
  background: var(--text-dim);
  flex: 0 0 auto;
}
.tab__dot--edit {
  background: var(--accent);
}
.tab__close {
  flex: 0 0 auto;
  width: 16px;
  text-align: center;
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0;
}
.tab:hover .tab__close,
.tab--active .tab__close {
  opacity: 1;
}
.tab__close:hover {
  color: var(--text-primary);
}
.tabbar__new {
  flex: 0 0 auto;
  width: var(--h-tabstrip);
  border: none;
  border-left: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
}
.tabbar__new:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
