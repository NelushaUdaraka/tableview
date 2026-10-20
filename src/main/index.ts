/** Electron main process entry point. */
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, Menu, app, shell } from 'electron'
import { AppImageUpdater, autoUpdater } from 'electron-updater'
import { CHANNELS } from '../shared/ipc'
import { ConnectionRegistry } from './db/registry'
import { AppData } from './storage/appData'
import { createVault } from './storage/crypto'
import { carryOverLegacyProfile } from './storage/legacyProfile'
import { registerIpcHandlers, scopeForWindow, setWindowFactory, setWindowLocator } from './ipc'
import { buildMenu } from './menu'
import { WindowManager } from './window'
import { closeGuard } from './closeGuard'
import { UpdateController, runningAppImage, updateMode } from './updater'

// One process owns the settings files; a second launch focuses the existing
// window rather than competing for them. Extra windows come from File → New
// Window, which keeps every window inside this process.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // TableView was called Beekeeper Clone, and its data is still in a folder of
  // that name. The first launch copies it across — here, before the profile is
  // read by anything, Chromium's start-up included.
  const carried = carryOverLegacyProfile({
    appData: app.getPath('appData'),
    userData: app.getPath('userData'),
    name: app.getName()
  })
  if (carried.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[profile] brought ${carried.join(', ')} over from Beekeeper Clone`)
  }
}

const registry = new ConnectionRegistry()
let windows: WindowManager | null = null
let updates: UpdateController | null = null
/** Running from an AppImage, which then replaces its own file to update. */
const appImage = runningAppImage(process.env, process.execPath)

/**
 * How this Linux copy was installed, as the package itself records it: the
 * .deb carries a `package-type` file in its resources. Nothing else does.
 */
function packageType(): string | undefined {
  if (!app.isPackaged || process.platform !== 'linux') return undefined
  try {
    return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim()
  } catch {
    return undefined
  }
}

/**
 * How long the windows say the update is going in before the app closes, so
 * the message is read rather than flashed.
 */
const INSTALL_NOTICE_MS = 1500

/**
 * Restarts into a downloaded update. Unsaved work is asked about first, the
 * way a quit asks.
 *
 * The Windows installer closes whatever is still running, and it does not
 * ask, so there the connections are closed before it starts rather than
 * racing it on the way out: an SSM session cut off mid-close leaves its
 * plugin process behind. An AppImage puts the new file in place before this
 * copy quits, and the quit closes the connections as any quit does.
 *
 * Before anything closes, every window says the update is going in and what
 * comes next, since a window that simply vanishes looks like a crash.
 */
async function restartToUpdate(): Promise<void> {
  if (updates?.state.status !== 'ready') return
  const mayGo = (): boolean => closeGuard.mayQuit(windows?.all ?? [], () => void restartToUpdate())
  if (!mayGo()) return
  updates.beginInstall()
  if (process.platform === 'win32') {
    await registry.closeAll()
    // Anything left unsaved while the connections were closing is asked about
    // too — with the update back to waiting, so the question is not hidden.
    if (!mayGo()) {
      updates.cancelInstall()
      return
    }
  }
  await new Promise((resolve) => setTimeout(resolve, INSTALL_NOTICE_MS))
  // The new AppImage is started before this copy has quit, and would find the
  // single-instance lock still held and quit at once. If the install fails,
  // nothing quits, and the lock is taken back.
  if (appImage) app.releaseSingleInstanceLock()
  if (!updates.install() && appImage) app.requestSingleInstanceLock()
}

function createWindow(position?: { x: number; y: number }): BrowserWindow | null {
  if (!windows) return null
  const window = windows.create(path.join(__dirname, '../preload/index.js'), position)

  // Keep navigation inside the app; open real links in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Unsaved work is asked about before the window goes.
  closeGuard.watch(window)

  // A window's connections belong to it alone, so close them with it.
  window.on('closed', () => {
    void registry.closeScope(scopeForWindow(window))
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

void app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData')

  // safeStorage is only meaningful once the app is ready.
  const { safeStorage } = await import('electron')
  const vault = createVault(userDataDir, safeStorage)
  const appData = new AppData(userDataDir, vault)

  windows = new WindowManager(userDataDir)

  updates = new UpdateController({
    mode: updateMode({
      isPackaged: app.isPackaged,
      platform: process.platform,
      env: process.env,
      execPath: process.execPath,
      packageType: packageType()
    }),
    enabled: appData.getSettings().autoUpdate,
    installed: appData.noteRunningVersion(app.getVersion()),
    // electron-updater picks its Linux updater by the package-type marker,
    // which an AppImage can carry too (see updateMode); so it is asked for
    // by name here.
    updater: () => (appImage ? new AppImageUpdater() : autoUpdater),
    // Every window says how updating is going, so every window is told.
    onChange: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(CHANNELS.eventUpdateState, state)
      }
    }
  })

  registerIpcHandlers({
    registry,
    appData,
    updates,
    restartToUpdate: () => void restartToUpdate(),
    getWindow: () => windows?.current ?? null
  })
  setWindowFactory(createWindow)
  // A tab dragged out of one window and let go over another has to be matched
  // to whichever window that was; only the manager knows where they are.
  setWindowLocator((point, exclude) => windows?.windowAt(point, exclude) ?? null)

  Menu.setApplicationMenu(buildMenu(() => windows?.current ?? null, createWindow))
  createWindow()
  updates.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  const window = windows?.current
  if (window) {
    if (window.isMinimized()) window.restore()
    window.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Close pools and SSH/SSM tunnels before the process exits.
app.on('before-quit', (event) => {
  // Unsaved work is asked about before anything is closed: the windows holding
  // some are asked in turn, and the quit starts over once all have said yes.
  if (!closeGuard.mayQuit(windows?.all ?? [], () => app.quit())) {
    event.preventDefault()
    return
  }
  // Quitting with connections open exits the process outright, so no window
  // gets a close event to write its geometry with; do it here instead.
  windows?.flushState()
  if (registry.openCount === 0) return
  event.preventDefault()
  void registry.closeAll().finally(() => app.exit(0))
})
