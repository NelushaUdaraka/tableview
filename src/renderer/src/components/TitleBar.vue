<script setup lang="ts">
/**
 * The window's title bar: menus, title and window buttons in one strip.
 *
 * The window is frameless (inset on macOS), so this is the only chrome there
 * is. The menus are drawn from the same model the native menu is built from,
 * which keeps the two in step; the native menu is still installed and still
 * owns every accelerator, so nothing here has to re-implement shortcuts.
 *
 * macOS keeps its system menu bar, so this strip only carries the title and
 * leaves room for the traffic lights.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MenuItemModel } from '@shared/menu'
import { buildMenuModel, formatAccelerator } from '@shared/menu'
import type { WindowChromeState } from '@shared/ipc'
import { useConnectionStore } from '../stores/connections'
import { useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'
import { dispatchMenuAction } from '../lib/menuBus'
import { api } from '../lib/api'

const connections = useConnectionStore()
const settings = useSettingsStore()
const tabs = useTabStore()

const root = ref<HTMLElement | null>(null)
const menuBar = ref<HTMLElement | null>(null)
const open = ref<number | null>(null)
const highlight = ref(-1)
const dropdownLeft = ref(0)
const chrome = ref<WindowChromeState>({ maximized: false, fullScreen: false, focused: true })

const platform = computed(() => settings.appInfo?.platform ?? 'linux')
const isMac = computed(() => platform.value === 'darwin')

/** macOS shows the menus in its own bar; repeating them here would be wrong. */
const menus = computed(() =>
  isMac.value
    ? []
    : buildMenuModel(platform.value).map((menu) => ({
        label: menu.label,
        items: menu.items.filter((item) => !item.nativeOnly)
      }))
)

/** The open menu's items, so the template never indexes with a nullable. */
const openItems = computed<MenuItemModel[]>(() =>
  open.value === null ? [] : (menus.value[open.value]?.items ?? [])
)

const title = computed(() => {
  const parts: string[] = []
  const tab = tabs.active
  if (tab) parts.push(tab.kind === 'table' ? `${tab.schema}.${tab.table}` : tab.title)
  if (connections.active) parts.push(connections.active.name)
  parts.push('Beekeeper Clone')
  return parts.join(' — ')
})

watch(title, (next) => (document.title = next), { immediate: true })

// --- the menu ---------------------------------------------------------------

function openMenu(index: number): void {
  open.value = index
  highlight.value = -1
  const buttons = menuBar.value?.querySelectorAll<HTMLElement>('.titlebar__menu')
  dropdownLeft.value = buttons?.[index]?.offsetLeft ?? 0
}

function closeMenu(): void {
  open.value = null
  highlight.value = -1
}

function toggleMenu(index: number): void {
  if (open.value === index) closeMenu()
  else openMenu(index)
}

/** Once a menu is open, sliding along the bar switches between them. */
function onMenuHover(index: number): void {
  if (open.value !== null && open.value !== index) openMenu(index)
}

function isSelectable(item: MenuItemModel): boolean {
  return !item.separator
}

function step(delta: number): void {
  const items = openItems.value
  if (items.length === 0) return
  let next = highlight.value
  for (let i = 0; i < items.length; i += 1) {
    next = (next + delta + items.length) % items.length
    if (isSelectable(items[next])) break
  }
  highlight.value = next
}

async function run(item: MenuItemModel): Promise<void> {
  closeMenu()
  if (item.action) {
    dispatchMenuAction(item.action)
    return
  }
  if (item.role) {
    await api.runMenuRole(item.role)
    return
  }
  if (item.command === 'window:new') {
    await api.openNewWindow()
    return
  }
  if (item.link) await api.openExternal(item.link)
}

function onDocumentMouseDown(event: MouseEvent): void {
  if (open.value === null) return
  if (root.value?.contains(event.target as Node)) return
  closeMenu()
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (open.value === null) return

  switch (event.key) {
    case 'Escape':
      event.preventDefault()
      closeMenu()
      break
    case 'ArrowDown':
      event.preventDefault()
      step(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      step(-1)
      break
    case 'ArrowRight':
      event.preventDefault()
      openMenu((open.value + 1) % menus.value.length)
      break
    case 'ArrowLeft':
      event.preventDefault()
      openMenu((open.value - 1 + menus.value.length) % menus.value.length)
      break
    case 'Enter': {
      const item = openItems.value[highlight.value]
      if (item && isSelectable(item)) {
        event.preventDefault()
        void run(item)
      }
      break
    }
  }
}

// --- window buttons ---------------------------------------------------------

let unsubscribeChrome: (() => void) | null = null

onMounted(async () => {
  document.addEventListener('mousedown', onDocumentMouseDown)
  document.addEventListener('keydown', onDocumentKeydown)
  unsubscribeChrome = api.onWindowChrome((state) => {
    chrome.value = state
  })
  try {
    chrome.value = await api.getWindowChrome()
  } catch {
    // A window that cannot describe itself still gets a usable title bar.
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  unsubscribeChrome?.()
})
</script>

<template>
  <header
    ref="root"
    class="titlebar"
    :class="{
      'titlebar--mac': isMac,
      'titlebar--fullscreen': chrome.fullScreen,
      'titlebar--blurred': !chrome.focused
    }"
  >
    <div class="titlebar__left">
      <template v-if="!isMac">
        <div class="titlebar__logo" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <path d="M8 1.2 14 4.6v6.8L8 14.8 2 11.4V4.6z" fill="currentColor" />
            <path d="M3.4 6.6h9.2M3.4 9.4h9.2" stroke="var(--bg-raised)" stroke-width="1.6" />
          </svg>
        </div>
        <nav ref="menuBar" class="titlebar__menus">
          <button
            v-for="(menu, index) in menus"
            :key="menu.label"
            class="titlebar__menu"
            :class="{ 'titlebar__menu--open': open === index }"
            @click="toggleMenu(index)"
            @mouseenter="onMenuHover(index)"
          >
            {{ menu.label }}
          </button>

          <div
            v-if="open !== null"
            class="titlebar__dropdown"
            :style="{ left: `${dropdownLeft}px` }"
          >
            <template v-for="(item, index) in openItems" :key="index">
              <div v-if="item.separator" class="titlebar__sep"></div>
              <button
                v-else
                class="titlebar__item"
                :class="{ 'titlebar__item--highlight': highlight === index }"
                @click="run(item)"
                @mouseenter="highlight = index"
              >
                <span class="titlebar__item-label">{{ item.label }}</span>
                <span class="titlebar__item-key">{{
                  formatAccelerator(item.accelerator, platform)
                }}</span>
              </button>
            </template>
          </div>
        </nav>
      </template>
    </div>

    <div class="titlebar__title truncate">{{ title }}</div>

    <div class="titlebar__right">
      <div v-if="!isMac" class="titlebar__controls">
        <button class="titlebar__control" title="Minimise" @click="api.minimizeWindow()">
          <svg viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" /></svg>
        </button>
        <button
          class="titlebar__control"
          :title="chrome.maximized ? 'Restore' : 'Maximise'"
          @click="api.toggleMaximizeWindow()"
        >
          <svg v-if="chrome.maximized" viewBox="0 0 10 10">
            <path d="M2.5.5h7v7h-2" fill="none" stroke="currentColor" />
            <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
          </svg>
          <svg v-else viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
        </button>
        <button
          class="titlebar__control titlebar__control--close"
          title="Close"
          @click="api.closeWindow()"
        >
          <svg viewBox="0 0 10 10">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: stretch;
  height: var(--h-titlebar);
  flex: 0 0 auto;
  background: var(--bg-raised);
  border-bottom: var(--rule) solid var(--border-strong);
  font-size: 13px;
  user-select: none;
  -webkit-app-region: drag;
  position: relative;
  z-index: 400;
}
.titlebar--blurred {
  color: var(--text-muted);
}

.titlebar__left,
.titlebar__right {
  display: flex;
  align-items: stretch;
  /* Equal flex on both sides keeps the title centred in the window. */
  flex: 1 1 0;
  min-width: 0;
}
.titlebar__right {
  justify-content: flex-end;
}
/* Room for the macOS traffic lights, which sit over this strip — and none
   needed in full screen, where macOS takes them away. */
.titlebar--mac:not(.titlebar--fullscreen) .titlebar__left {
  min-width: 78px;
}

.titlebar__logo {
  display: flex;
  align-items: center;
  padding: 0 12px 0 14px;
  color: var(--accent);
}
.titlebar__logo svg {
  width: 17px;
  height: 17px;
}

.titlebar__menus {
  position: relative;
  display: flex;
  align-items: stretch;
  -webkit-app-region: no-drag;
}
.titlebar__menu {
  padding: 0 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: default;
  white-space: nowrap;
}
.titlebar__menu:hover {
  background: var(--bg-hover-strong);
  color: var(--text-primary);
}
/* The open menu drops to the content ground and takes the accent underline,
   so the strip reads as continuous with the panel below it. */
.titlebar__menu--open {
  background: var(--bg-app);
  color: var(--text-primary);
  box-shadow: inset 0 -2px 0 var(--accent);
}

.titlebar__dropdown {
  position: absolute;
  top: 100%;
  min-width: 272px;
  padding: 4px 0;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--bg-surface);
  box-shadow: var(--shadow-menu);
  z-index: 500;
}
.titlebar__item {
  display: flex;
  align-items: center;
  gap: 24px;
  width: 100%;
  padding: 7px 14px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  text-align: left;
  cursor: default;
}
.titlebar__item:hover,
.titlebar__item--highlight {
  background: var(--bg-hover-strong);
}
.titlebar__item-label {
  flex: 1;
  white-space: nowrap;
}
.titlebar__item-key {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
}
.titlebar__sep {
  height: 1px;
  margin: 4px 0;
  background: var(--border-strong);
}

.titlebar__title {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 1 auto;
  padding: 0 16px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.titlebar__controls {
  display: flex;
  align-items: stretch;
  -webkit-app-region: no-drag;
}
.titlebar__control {
  width: 46px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: default;
  display: flex;
  align-items: center;
  justify-content: center;
}
.titlebar__control svg {
  width: 10px;
  height: 10px;
  stroke-width: 1.2;
  fill: none;
  shape-rendering: crispEdges;
}
.titlebar__control:hover {
  background: var(--bg-hover-strong);
  color: var(--text-primary);
}
/* Close is the one window button that earns the accent. */
.titlebar__control--close:hover {
  background: var(--accent);
  color: var(--accent-text);
}
</style>
