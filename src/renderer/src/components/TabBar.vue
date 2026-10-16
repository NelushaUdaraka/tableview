<script setup lang="ts">
/**
 * One pane's strip of tabs.
 *
 * A split workspace has one of these per pane, so the strip is told which pane
 * it belongs to rather than reading "the" tab list. Tabs can be dragged: within
 * a strip to reorder, onto the other pane's strip to move there, and out of the
 * window entirely — onto another window to move into it, or onto nothing at all
 * to open in a window of their own.
 */
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import ContextMenu, { type MenuEntry } from './ContextMenu.vue'
import type { IconName } from '../lib/icons'
import { beginTabDrag, draggedTab, endTabDrag, markTabDropped } from '../lib/tabDrag'
import { useTabStore, type Tab, type TabPane } from '../stores/tabs'

const props = defineProps<{ pane: TabPane }>()
const emit = defineEmits<{
  (event: 'new-query'): void
  (event: 'detach', tabId: string, position: { x: number; y: number }): void
  (event: 'drop-out', tabId: string, point: { x: number; y: number }): void
}>()

const tabs = useTabStore()
const menu = ref<{ x: number; y: number; id: string } | null>(null)

/** Where a drop would insert, drawn as a rule between two tabs. */
const dropIndex = ref<number | null>(null)

const scroller = ref<HTMLElement | null>(null)

/**
 * Keeps the tab on screen in view. One opened into a full strip lands past
 * its end, and the strip has no scrollbar to go and find it with.
 */
watch(
  () => props.pane.activeTabId,
  () => {
    void nextTick(() => {
      scroller.value
        ?.querySelector<HTMLElement>('.tab--active')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
)

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

/** The icon the tree gives the same thing: a routine's tab is that routine. */
function icon(tab: Tab): IconName {
  if (tab.kind === 'table') return 'table'
  if (tab.routine) return tab.routine.type && tab.routine.type !== 'procedure' ? 'function' : 'procedure'
  return 'terminal'
}

/**
 * Whether a tab's dot is up, and what it says.
 *
 * A routine's tab differs from the server or it does not — reverting every
 * change, or running the script, puts the dot away. Any other query tab has
 * unsaved text from its first keystroke until it is saved.
 */
function unsaved(tab: Tab): string {
  if (tab.kind !== 'query') return ''
  if (tab.routine) {
    const count = tab.changeCount ?? 0
    return count > 0 ? `${count} ${count === 1 ? 'change' : 'changes'} not saved to the database` : ''
  }
  return tab.dirty ? 'Unsaved changes' : ''
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
 * A tab let go outside the window leaves it.
 *
 * There is no drop target out there to tell us — a drag does not cross from
 * one window's document into another's — so the pointer's position at the end
 * of the drag is all there is to go on: `screenX`/`screenY` against this
 * window's own frame says it left, and where it went is for the main process
 * to say, since only it knows where the other windows are. A drag that landed
 * on a strip has already been dealt with.
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
  emit('drop-out', tabId, { x: event.screenX, y: event.screenY })
}
</script>

<template>
  <!-- The whole bar takes drops, so the room after `+` is still the strip's end. -->
  <div
    class="tabbar"
    :class="{ 'tabbar--focused': tabs.focusedPaneId === pane.id }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @mousedown="tabs.focusPane(pane.id)"
  >
    <div ref="scroller" class="tabbar__scroll">
      <template v-for="(tab, index) in tabs.tabsIn(pane.id)" :key="tab.id">
        <span v-if="dropIndex === index" class="tabbar__drop" aria-hidden="true"></span>
        <button
          class="tab"
          :class="{
            'tab--active': tab.id === pane.activeTabId,
            'tab--dimmed': tab.id === pane.activeTabId && tabs.focusedPaneId !== pane.id
          }"
          draggable="true"
          :title="
            tab.kind === 'table'
              ? `${tab.schema}.${tab.table}`
              : tab.routine
                ? `${tab.routine.schema}.${tab.routine.name}`
                : tab.title
          "
          @click="tabs.select(tab.id)"
          @auxclick="onAuxClick($event, tab.id)"
          @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, id: tab.id }"
          @dragstart="onDragStart($event, tab.id)"
          @dragend="onDragEnd($event, tab.id)"
        >
          <AppIcon class="tab__icon" :name="icon(tab)" :size="14" />
          <span class="tab__title truncate">{{ tab.title }}</span>
          <span v-if="tab.kind === 'query' && tab.running" class="spinner tab__spinner"></span>
          <span v-else-if="unsaved(tab)" class="tab__dot" :title="unsaved(tab)"></span>
          <span
            v-else-if="tab.kind === 'table' && tab.pendingEdits > 0"
            class="tab__dot tab__dot--edit"
            :title="`${tab.pendingEdits} pending change(s)`"
          ></span>
          <span class="tab__close" title="Close" @click.stop="tabs.close(tab.id)">
            <AppIcon name="x" :size="12" />
          </span>
        </button>
      </template>
      <span
        v-if="dropIndex !== null && dropIndex >= tabs.tabsIn(pane.id).length"
        class="tabbar__drop"
        aria-hidden="true"
      ></span>
    </div>

    <button
      class="tabbar__new"
      title="New query (Ctrl+T)"
      aria-label="New query"
      @click="emit('new-query')"
    >
      <AppIcon name="plus" :size="16" />
    </button>

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
/* The strip's own hairline is painted under the tabs, so the active tab — on
   the content's ground — covers it and reads as part of the panel below. */
.tabbar {
  display: flex;
  align-items: stretch;
  height: var(--h-tabstrip);
  background: var(--bg-app);
  box-shadow: inset 0 -1px 0 var(--border-subtle);
  flex: 0 0 auto;
}
/* As wide as its tabs, so `+` sits right after the last one; once they no
   longer fit, the tabs scroll and `+` stays in view at the end.
   The divider that closes off the last tab is painted on this ground rather
   than on the tab: it stays at the strip's visible end while the tabs scroll,
   so a tab cut off there does not run into `+`, and a tab with a ground of its
   own — hovered, or the one in front, which draws its own sides — covers it,
   just as the dividers between tabs give way beside those. */
.tabbar__scroll {
  display: flex;
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  background-image: linear-gradient(var(--border-subtle), var(--border-subtle));
  background-position: right center;
  /* Stopping 11px short of each edge, like the dividers between tabs. */
  background-size: 1px calc(100% - 22px);
  background-repeat: no-repeat;
}
.tabbar__scroll::-webkit-scrollbar {
  height: 0;
}
/* Where a dragged tab would land. */
.tabbar__drop {
  flex: 0 0 auto;
  width: 2px;
  margin: 7px 0;
  border-radius: 2px;
  background: var(--accent);
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 220px;
  min-width: 124px;
  padding: 0 8px 0 12px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--transition),
    color var(--transition);
}
/* Short dividers between resting tabs, gone beside the one in front. */
.tab + .tab::before {
  content: '';
  position: absolute;
  left: 0;
  top: 11px;
  bottom: 11px;
  width: 1px;
  background: var(--border-subtle);
}
.tab:hover::before,
.tab:hover + .tab::before,
.tab--active::before,
.tab--active + .tab::before {
  opacity: 0;
}
.tab:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}
/* The active tab stands on the panel: the content's ground, hairline sides,
   and the accent along its top edge. */
.tab--active,
.tab--active:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow:
    inset 0 2px 0 var(--accent),
    inset 1px 0 0 var(--border-subtle),
    inset -1px 0 0 var(--border-subtle);
}
/* Split view shows two tabs at once; the one in the pane that does not have
   the focus keeps its card but gives up the full-strength accent. */
.tab--dimmed,
.tab--dimmed:hover {
  color: var(--text-secondary);
  box-shadow:
    inset 0 2px 0 var(--border-hover),
    inset 1px 0 0 var(--border-subtle),
    inset -1px 0 0 var(--border-subtle);
}
.tab__icon {
  color: var(--text-muted);
}
.tab--active .tab__icon {
  color: var(--accent-fg);
}
.tab--dimmed .tab__icon {
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
  margin: 0 3px;
  border-radius: 50%;
  background: var(--text-muted);
  flex: 0 0 auto;
}
.tab__dot--edit {
  background: var(--accent);
}
.tab__close {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  opacity: 0;
  transition:
    opacity var(--transition),
    background-color var(--transition),
    color var(--transition);
}
.tab:hover .tab__close,
.tab--active .tab__close {
  opacity: 1;
}
.tab__close:hover {
  background: var(--bg-active);
  color: var(--text-primary);
}
.tabbar__new {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 30px;
  margin: 4px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background-color var(--transition),
    color var(--transition);
}
/* `+` sits in a slot of its own, like a tab, with its 6px margin between it
   and a divider either side: the one that closes off the last tab, and this
   one. 7px top and bottom, with its 4px margin, is the 11px the tabs' dividers
   stop short of the strip's edges. Once the tabs overflow, `+` is pinned to
   the bar's end and this falls just past it, where the pane clips it: the
   pane's own edge closes the slot there. */
.tabbar__new::after {
  content: '';
  position: absolute;
  right: -7px;
  top: 7px;
  bottom: 7px;
  width: 1px;
  background: var(--border-subtle);
  pointer-events: none;
}
.tabbar__new:hover {
  background: var(--bg-hover-strong);
  color: var(--text-primary);
}
</style>
