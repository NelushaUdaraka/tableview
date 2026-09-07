/**
 * Window creation and geometry persistence.
 *
 * Several windows can be open at once — the intended way to work with more
 * than one connection. Each is independent; the most recently moved or resized
 * one supplies the default geometry for the next.
 *
 * The frame is drawn by the renderer: Windows and Linux get a frameless window
 * and macOS an inset title bar, so one strip can hold the menus, the title and
 * the window buttons. Everything the renderer cannot see for itself — whether
 * the window is maximised, full screen or focused — is pushed to it.
 */
import path from 'node:path'
import { BrowserWindow, screen } from 'electron'
import { CHANNELS, WindowChromeState } from '../shared/ipc'
import { JsonStore } from './storage/store'

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

const DEFAULT_STATE: WindowState = { width: 1440, height: 900, maximized: false }
/** Offset each new window so it does not land exactly on top of the last. */
const CASCADE_STEP = 28

export class WindowManager {
  private readonly store: JsonStore<WindowState>
  private readonly windows = new Set<BrowserWindow>()
  private lastFocused: BrowserWindow | null = null

  constructor(private readonly userDataDir: string) {
    this.store = new JsonStore(path.join(userDataDir, 'window-state.json'), () => ({
      ...DEFAULT_STATE
    }))
  }

  /** The window the user is working in, for menu actions and dialogs. */
  get current(): BrowserWindow | null {
    if (this.lastFocused && !this.lastFocused.isDestroyed()) return this.lastFocused
    const focused = BrowserWindow.getFocusedWindow()
    if (focused) return focused
    return [...this.windows].find((window) => !window.isDestroyed()) ?? null
  }

  get all(): BrowserWindow[] {
    return [...this.windows].filter((window) => !window.isDestroyed())
  }

  get count(): number {
    return this.all.length
  }

  create(preloadPath: string): BrowserWindow {
    const state = this.restoreState()
    const offset = this.windows.size * CASCADE_STEP
    const isMac = process.platform === 'darwin'

    const window = new BrowserWindow({
      width: state.width,
      height: state.height,
      x: state.x === undefined ? undefined : state.x + offset,
      y: state.y === undefined ? undefined : state.y + offset,
      minWidth: 900,
      minHeight: 560,
      show: false,
      title: 'Beekeeper Clone',
      backgroundColor: '#16181d',
      // The custom title bar replaces the system one. On macOS the traffic
      // lights stay, inset over the renderer's strip.
      frame: isMac,
      titleBarStyle: isMac ? 'hiddenInset' : 'default',
      trafficLightPosition: isMac ? { x: 12, y: 11 } : undefined,
      autoHideMenuBar: false,
      webPreferences: {
        preload: preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })

    // The menu still supplies every accelerator; only its bar is hidden,
    // because the title bar draws those items itself.
    if (!isMac) window.setMenuBarVisibility(false)

    // Only the first window inherits "maximized"; later ones cascade instead.
    if (state.maximized && this.windows.size === 0) window.maximize()
    window.once('ready-to-show', () => window.show())

    const persist = (): void => this.persistState(window)
    const announce = (): void => sendChromeState(window)
    window.on('resize', persist)
    window.on('move', persist)
    window.on('close', persist)
    window.on('maximize', announce)
    window.on('unmaximize', announce)
    window.on('enter-full-screen', announce)
    window.on('leave-full-screen', announce)
    window.on('blur', announce)
    window.on('focus', () => {
      this.lastFocused = window
      announce()
    })
    window.on('closed', () => {
      this.windows.delete(window)
      if (this.lastFocused === window) this.lastFocused = null
    })

    this.windows.add(window)
    this.lastFocused = window
    return window
  }

  /** Clamps a restored position so a window from an unplugged monitor is visible. */
  private restoreState(): WindowState {
    const state = { ...DEFAULT_STATE, ...this.store.read() }
    if (state.x === undefined || state.y === undefined) return state

    const visible = screen.getAllDisplays().some((display) => {
      const { x, y, width, height } = display.workArea
      return (
        state.x! >= x - 50 &&
        state.y! >= y - 50 &&
        state.x! + 100 <= x + width &&
        state.y! + 100 <= y + height
      )
    })

    return visible ? state : { ...state, x: undefined, y: undefined }
  }

  private persistState(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    const maximized = window.isMaximized()
    // A maximized window reports the screen bounds; keep the restore size.
    if (maximized) {
      this.store.write({ ...this.store.read(), maximized })
      return
    }
    const bounds = window.getBounds()
    this.store.write({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized
    })
  }
}

/** What the renderer's title bar needs to draw itself correctly. */
export function chromeState(window: BrowserWindow | null): WindowChromeState {
  if (!window || window.isDestroyed()) {
    return { maximized: false, fullScreen: false, focused: false }
  }
  return {
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
    focused: window.isFocused()
  }
}

function sendChromeState(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  window.webContents.send(CHANNELS.eventWindowChrome, chromeState(window))
}
