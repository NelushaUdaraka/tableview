<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DetachedTab, WindowCloseReason } from '@shared/ipc'
import type { MenuAction } from '@shared/menu'
import ConnectionScreen from './views/ConnectionScreen.vue'
import TitleBar from './components/TitleBar.vue'
import ProgressBar from './components/ProgressBar.vue'
import WorkspaceView from './views/WorkspaceView.vue'
import ToastHost from './components/ToastHost.vue'
import CredentialsExpiredDialog from './components/CredentialsExpiredDialog.vue'
import ReadOnlyWarningDialog from './components/ReadOnlyWarningDialog.vue'
import { useConnectionStore } from './stores/connections'
import { useSettingsStore } from './stores/settings'
import { useTabStore } from './stores/tabs'
import { useToastStore } from './stores/toasts'
import { dispatchMenuAction } from './lib/menuBus'
import { applyAccent } from './lib/accent'
import { openTabFrom } from './lib/detach'
import { api } from './lib/api'

const connections = useConnectionStore()
const settings = useSettingsStore()
const tabs = useTabStore()
const toasts = useToastStore()
const ready = ref(false)
/**
 * Whether this window was opened to hold one tab dragged out of another.
 *
 * Such a window is that tab and nothing else — no schema tree beside it, the
 * way a dragged-out editor opens in its own window with none of the workbench
 * around it. Everything is still a keystroke away; none of it is in the way.
 */
const detached = ref(false)

/**
 * Opens a tab this window has been handed by another one.
 *
 * A tab that arrives from elsewhere is a description, not state: windows share
 * no connection pool, so this one opens its own — unless it already holds that
 * connection, which is what a tab dragged *back* into the window it came from
 * finds, and reopening it would pull the pool and the tunnel out from under
 * the tabs already here.
 */
async function openIncomingTab(incoming: DetachedTab): Promise<boolean> {
  if (connections.statusFor(incoming.connectionId).state === 'connected') {
    connections.activeId = incoming.connectionId
  } else {
    const status = await connections.connect(incoming.connectionId)
    if (status.state !== 'connected') {
      toasts.error('Could not open that tab in this window', status.error?.message)
      return false
    }
  }

  await openTabFrom(incoming)
  return true
}

/**
 * Opens the tab this window was created for, if it was created for one.
 *
 * Done before the workspace is shown, so the window opens onto the tab rather
 * than onto a blank query.
 */
async function openDetachedTab(): Promise<void> {
  const pending = await api.takePendingTab()
  if (!pending) return
  if (await openIncomingTab(pending)) detached.value = true
}

/**
 * A tab dragged out of another window and let go over this one.
 *
 * Nothing about it is settled when it arrives: this window may be on another
 * connection, or on none at all and still showing the connection screen, so
 * opening it is the same job as opening the tab a detached window was made
 * for — only later, and without making this window a detached one.
 */
async function adoptTab(incoming: DetachedTab): Promise<void> {
  try {
    await openIncomingTab(incoming)
  } catch (error) {
    toasts.fromError('Could not open that tab in this window', error)
  }
}

/**
 * The window takes the colour of the connection open in it.
 *
 * A window is one connection, so the accent can say which one at a glance —
 * production and staging side by side stop looking alike. The theme is in it
 * because one of the shades the accent produces is a tint that has to sit on
 * whichever ground is underneath.
 */
watch(
  () => [connections.active?.color, settings.resolvedTheme] as const,
  ([colour, theme]) => applyAccent(colour, theme),
  { immediate: true }
)

/**
 * Tells the main process whether this window holds work that closing it would
 * lose — staged table edits, a routine's unsaved changes. While it does, a
 * close of the window, or a quit of the app, is held and asked about here.
 */
watch(
  () => tabs.hasUnsavedWork,
  (unsaved) => void api.setUnsavedWork(unsaved),
  { immediate: true }
)

/**
 * The window is closing, or the app quitting, with unsaved work in it: every
 * tab holding some is asked, as closing it would ask it, and the main process
 * is told whether to go ahead. An answer is always sent — a window left
 * waiting on one could never be closed.
 */
async function answerCloseRequest(reason: WindowCloseReason): Promise<void> {
  let proceed = false
  try {
    proceed = await tabs.canCloseWindow(reason)
  } finally {
    void api.answerCloseRequest(proceed)
  }
}

let unsubscribeMenu: (() => void) | null = null
let unsubscribeAttach: (() => void) | null = null
let unsubscribeClose: (() => void) | null = null

onMounted(async () => {
  // Actions from the native menu join the ones the title bar raises, so views
  // only ever subscribe to the bus.
  unsubscribeMenu = api.onMenuAction((action) => dispatchMenuAction(action as MenuAction))
  // Tabs can arrive at any moment: another window is only ever a drag away.
  unsubscribeAttach = api.onAttachTab((incoming) => void adoptTab(incoming))
  unsubscribeClose = api.onCloseRequested((reason) => void answerCloseRequest(reason))
  try {
    await settings.load()
    await connections.load()
    await openDetachedTab()
  } catch (error) {
    toasts.fromError('Could not start up cleanly', error)
  } finally {
    ready.value = true
  }
})

onBeforeUnmount(() => {
  unsubscribeMenu?.()
  unsubscribeAttach?.()
  unsubscribeClose?.()
})
</script>

<template>
  <div class="app">
    <TitleBar />
    <!-- Spans the window, under the title bar: whatever is loading, it shows here. -->
    <ProgressBar />
    <div class="app__body">
      <div v-if="!ready" class="empty-state">
        <span class="spinner"></span>
      </div>
      <!-- The session, not the socket: a connection being reopened keeps its
           tabs rather than dropping back to the connection screen. -->
      <WorkspaceView v-else-if="connections.inSession" :detached="detached" />
      <ConnectionScreen v-else />
    </div>
    <ToastHost />
    <!-- Raised from anywhere a session can run out, so it lives above the views. -->
    <CredentialsExpiredDialog />
    <!-- Asked by every read-only toggle — the status bar, the list, the form. -->
    <ReadOnlyWarningDialog />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.app__body {
  flex: 1;
  min-height: 0;
}
</style>
