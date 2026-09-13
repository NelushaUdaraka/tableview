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
/**
 * How long geometry is held before it reaches disk.
 *
 * Dragging a window's edge raises `resize` continuously — dozens of times a
 * second — and writing on each one replaces the file just as often: wasted
 * work, and the surest way to collide with whatever else on the machine has
 * that file open for a moment. Where the drag comes to rest is the part worth
 * recording, and a short wait is enough to catch it.
 */
const WRITE_DELAY_MS = 400

export class WindowManager {
  private readonly store: JsonStore<WindowState>
  private readonly windows = new Set<BrowserWindow>()
  private lastFocused: BrowserWindow | null = null
  /** Geometry seen but not yet written; `null` once it has reached disk. */
  private pendingState: WindowState | null = null
  private writeTimer: ReturnType<typeof setTimeout> | null = null

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

  /**
   * Opens a window. `position` places it where a dragged-out tab was dropped,
   * clamped to a display so a drop past the edge of the screen still lands
   * somewhere visible.
   */
  create(preloadPath: string, position?: { x: number; y: number }): BrowserWindow {
    const state = this.restoreState()
    const offset = this.windows.size * CASCADE_STEP
    const isMac = process.platform === 'darwin'
    const dropped = position ? clampToDisplay(position, state.width, state.height) : null

    const window = new BrowserWindow({
      width: state.width,
      height: state.height,
      x: dropped ? dropped.x : state.x === undefined ? undefined : state.x + offset,
      y: dropped ? dropped.y : state.y === undefined ? undefined : state.y + offset,
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
    // A window opened at a dropped position is never maximised — the point of
    // the drop was to put it somewhere.
    if (state.maximized && this.windows.size === 0 && !dropped) window.maximize()
    window.once('ready-to-show', () => window.show())

    const persist = (): void => this.persistState(window)
    const announce = (): void => sendChromeState(window)
    window.on('resize', persist)
    window.on('move', persist)
    // The last thing a window does is worth writing straight away: there is no
    // later event to carry it, and by the next tick the window is gone.
    window.on('close', () => {
      this.persistState(window)
      this.flushState()
    })
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
    // Geometry on its way to disk is still the most recent there is, so a
    // window opened during that wait cascades from it rather than from the
    // position before it.
    const state = { ...DEFAULT_STATE, ...(this.pendingState ?? this.store.read()) }
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

  /**
   * Notes a window's geometry, and asks for it to be written before long.
   *
   * Reading the bounds is cheap and has to happen now — the window is still
   * there to ask. Writing them is neither, so it waits: see `WRITE_DELAY_MS`.
   */
  private persistState(window: BrowserWindow): void {
    // A minimized window reports a position off the edge of every display,
    // which is not somewhere to reopen it.
    if (window.isDestroyed() || window.isMinimized()) return
    const maximized = window.isMaximized()
    // A maximized window reports the screen bounds; keep the restore size.
    if (maximized) {
      this.pendingState = { ...(this.pendingState ?? this.store.read()), maximized }
    } else {
      const bounds = window.getBounds()
      this.pendingState = {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized
      }
    }
    this.scheduleWrite()
  }

  /**
   * One write per burst of events, rather than one per event.
   *
   * The timer is left to run once set: a drag that goes on for a while still
   * gets its first position recorded partway through, rather than nothing at
   * all until it ends.
   */
  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.flushState()
    }, WRITE_DELAY_MS)
    // Geometry alone should never hold the process open.
    this.writeTimer.unref?.()
  }

  /**
   * Writes whatever geometry is waiting.
   *
   * Where the file cannot be replaced — on Windows a scanner or an indexer
   * can hold it open — the window's size is not worth failing over: the next
   * move or resize will try again, and the app opens at its old size at worst.
   */
  flushState(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    const state = this.pendingState
    if (!state) return
    this.pendingState = null
    try {
      this.store.write(state)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[window] could not save the window geometry:', error)
    }
  }
}

/**
 * Keeps a dropped window on a screen.
 *
 * A tab can be let go anywhere, including past the edge of every display or
 * so close to one that the window would open mostly off it. This pulls the
 * frame back inside the work area of whichever display the drop was nearest.
 */
function clampToDisplay(
  position: { x: number; y: number },
  width: number,
  height: number
): { x: number; y: number } {
  const area = screen.getDisplayNearestPoint({
    x: Math.round(position.x),
    y: Math.round(position.y)
  }).workArea
  return {
    x: Math.round(Math.min(Math.max(position.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(position.y, area.y), area.y + area.height - height))
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
