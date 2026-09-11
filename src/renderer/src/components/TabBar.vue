<script setup lang="ts">
/**
 * One pane's strip of tabs.
 *
 * A split workspace has one of these per pane, so the strip is told which pane
 * it belongs to rather than reading "the" tab list. Tabs can be dragged: within
 * a strip to reorder, onto the other pane's strip to move there, and out of the
 * window entirely to open in a window of their own.
 */
import { computed, ref } from 'vue'
import ContextMenu, { type MenuEntry } from './ContextMenu.vue'
import { beginTabDrag, draggedTab, endTabDrag, markTabDropped } from '../lib/tabDrag'
import { useTabStore, type TabPane } from '../stores/tabs'

const props = defineProps<{ pane: TabPane }>()
const emit = defineEmits<{
  (event: 'new-query'): void
  (event: 'detach', tabId: string, position: { x: number; y: number }): void
}>()

const tabs = useTabStore()
const menu = ref<{ x: number; y: number; id: string } | null>(null)

/** Where a drop would insert, drawn as a rule between two tabs. */
const dropIndex = ref<number | null>(null)

const menuItems = computed<MenuEntry[]>(() => {
  if (!menu.value) return []
  const inThisPane = tabs.tabsIn(props.pane.id).length
  return [
    { label: 'Close', action: 'close', hint: 'Ctrl+W' },
    { label: 'Close others', action: 'close-others' },
    { label: 'Close all', action: 'close-all' },
    { separator: true, label: '' },
    {
      // With one tab in the pane there is nothing to move out of it, so the
      // split opens a second view of the same thing instead.
      label: tabs.isSplit
        ? 'Move to the other pane'
        : inThisPane > 1
          ? 'Open in split view'
          : 'Open a second view beside this',
      action: 'split'
    },
    { label: 'Close split', action: 'close-split', disabled: !tabs.isSplit },
    { separator: true, label: '' },
    { label: 'Move to a new window', action: 'detach' }
  ]
})

function onMenuSelect(action: string): void {
  const id = menu.value?.id
  if (!id) return
  if (action === 'close') void tabs.close(id)
  else if (action === 'close-others') void tabs.closeOthers(id)
  else if (action === 'close-all') void tabs.closeAll()
  else if (action === 'split') void tabs.splitTab(id)
  else if (action === 'close-split') void tabs.closeSplit()
  else if (action === 'detach') emit('detach', id, { x: window.screenX + 80, y: window.screenY + 80 })
}

function icon(kind: string): string {
  return kind === 'query' ? '⌨' : '▤'
}

/** Middle-click closes, matching browser and editor conventions. */
function onAuxClick(event: MouseEvent, id: string): void {
  if (event.button === 1) {
    event.preventDefault()
    void tabs.close(id)
  }
}

// --- dragging ---------------------------------------------------------------

function onDragStart(event: DragEvent, tabId: string): void {
  beginTabDrag({ tabId, paneId: props.pane.id })
  event.dataTransfer?.setData('text/plain', tabId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

/** The slot the pointer is over: before a tab, or after the last one. */
function indexAt(event: DragEvent): number {
  const strip = event.currentTarget as HTMLElement
  const buttons = [...strip.querySelectorAll<HTMLElement>('.tab')]
  for (let index = 0; index < buttons.length; index += 1) {
    const box = buttons[index].getBoundingClientRect()
    if (event.clientX < box.left + box.width / 2) return index
  }
  return buttons.length
}

function onDragOver(event: DragEvent): void {
  if (!draggedTab()) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dropIndex.value = indexAt(event)
}

function onDragLeave(): void {
  dropIndex.value = null
}

function onDrop(event: DragEvent): void {
  const drag = draggedTab()
  if (!drag) return
  event.preventDefault()
  markTabDropped()
  const index = indexAt(event)
  dropIndex.value = null
  void tabs.moveToPane(drag.tabId, props.pane.id, index)
}

/**
 * A tab let go outside the window asks for a window of its own.
 *
 * There is no drop target out there to tell us, so the pointer's position at
 * the end of the drag is what says it: `screenX`/`screenY` against the window's
 * own frame. A drag that landed on a strip has already been dealt with.
 */
function onDragEnd(event: DragEvent, tabId: string): void {
  dropIndex.value = null
  const { drag, landed } = endTabDrag()
  if (landed || !drag) return

  const outside =
    event.screenX < window.screenX ||
    event.screenY < window.screenY ||
    event.screenX > window.screenX + window.outerWidth ||
    event.screenY > window.screenY + window.outerHeight
  // Some platforms report 0,0 for a cancelled drag; that is not "outside".
  if (!outside || (event.screenX === 0 && event.screenY === 0)) return
  emit('detach', tabId, { x: event.screenX - 120, y: event.screenY - 20 })
}
</script>

<template>
  <div class="tabbar" :class="{ 'tabbar--focused': tabs.focusedPaneId === pane.id }">
    <div
      class="tabbar__scroll"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @mousedown="tabs.focusPane(pane.id)"
    >
      <template v-for="(tab, index) in tabs.tabsIn(pane.id)" :key="tab.id">
        <span v-if="dropIndex === index" class="tabbar__drop" aria-hidden="true"></span>
        <button
          class="tab"
          :class="{
            'tab--active': tab.id === pane.activeTabId,
            'tab--dimmed': tab.id === pane.activeTabId && tabs.focusedPaneId !== pane.id
          }"
          draggable="true"
          :title="tab.kind === 'table' ? `${tab.schema}.${tab.table}` : tab.title"
          @click="tabs.select(tab.id)"
          @auxclick="onAuxClick($event, tab.id)"
          @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, id: tab.id }"
          @dragstart="onDragStart($event, tab.id)"
          @dragend="onDragEnd($event, tab.id)"
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
      </template>
      <span
        v-if="dropIndex !== null && dropIndex >= tabs.tabsIn(pane.id).length"
        class="tabbar__drop"
        aria-hidden="true"
      ></span>
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
/* Where a dragged tab would land. */
.tabbar__drop {
  flex: 0 0 auto;
  width: 2px;
  background: var(--accent);
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
/* Split view shows two tabs at once; the one in the pane that does not have
   the focus keeps its card but gives up the full-strength accent. */
.tab--dimmed {
  color: var(--text-secondary);
  box-shadow: inset 0 2px 0 var(--border-strong);
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
