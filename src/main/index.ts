/** Electron main process entry point. */
import path from 'node:path'
import { BrowserWindow, Menu, app, shell } from 'electron'
import { ConnectionRegistry } from './db/registry'
import { AppData } from './storage/appData'
import { createVault } from './storage/crypto'
import { registerIpcHandlers, scopeForWindow, setWindowFactory } from './ipc'
import { buildMenu } from './menu'
import { WindowManager } from './window'

// One process owns the settings files; a second launch focuses the existing
// window rather than competing for them. Extra windows come from File → New
// Window, which keeps every window inside this process.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const registry = new ConnectionRegistry()
let windows: WindowManager | null = null

function createWindow(): void {
  if (!windows) return
  const window = windows.create(path.join(__dirname, '../preload/index.js'))

  // Keep navigation inside the app; open real links in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // A window's connections belong to it alone, so close them with it.
  window.on('closed', () => {
    void registry.closeScope(scopeForWindow(window))
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData')

  // safeStorage is only meaningful once the app is ready.
  const { safeStorage } = await import('electron')
  const vault = createVault(userDataDir, safeStorage)
  const appData = new AppData(userDataDir, vault)

  windows = new WindowManager(userDataDir)

  registerIpcHandlers({
    registry,
    appData,
    getWindow: () => windows?.current ?? null
  })
  setWindowFactory(createWindow)

  Menu.setApplicationMenu(buildMenu(() => windows?.current ?? null, createWindow))
  createWindow()

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
  if (registry.openCount === 0) return
  event.preventDefault()
  void registry.closeAll().finally(() => app.exit(0))
})
