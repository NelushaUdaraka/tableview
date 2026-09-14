/**
 * Window geometry, and how often it reaches disk.
 *
 * Dragging a window's edge raises `resize` continuously. Writing on every one
 * of those replaced `window-state.json` dozens of times a second, and on
 * Windows a replacement that lands while a scanner or an indexer has the file
 * open comes back EPERM — which, thrown out of an event handler in the main
 * process, took the whole app down with it. So: one write per burst, and a
 * write that cannot be made is not worth failing over.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** Just enough of a BrowserWindow for the manager to work with. */
class FakeWindow extends EventEmitter {
  bounds: Bounds
  maximized = false
  minimized = false
  destroyed = false
  readonly webContents = { id: 1, send: (): void => {} }

  constructor(options: { width: number; height: number; x?: number; y?: number }) {
    super()
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width,
      height: options.height
    }
  }

  getBounds(): Bounds {
    return { ...this.bounds }
  }

  /** Moves or resizes the window the way a drag does: one event per step. */
  dragTo(bounds: Partial<Bounds>): void {
    this.bounds = { ...this.bounds, ...bounds }
    this.emit('resize')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  isMaximized(): boolean {
    return this.maximized
  }
  isFullScreen(): boolean {
    return false
  }
  isFocused(): boolean {
    return true
  }
  maximize(): void {
    this.maximized = true
  }
  show(): void {}
  setMenuBarVisibility(): void {}
}

const display = { workArea: { x: 0, y: 0, width: 2560, height: 1400 } }

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  screen: {
    getAllDisplays: () => [display],
    getDisplayNearestPoint: () => display
  }
}))

const { WindowManager } = await import('../../src/main/window')

let dir: string
let file: string

beforeEach(() => {
  vi.useFakeTimers()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-window-'))
  file = path.join(dir, 'window-state.json')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

function saved(): { width: number; height: number; x?: number; y?: number; maximized: boolean } {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function open(): { manager: InstanceType<typeof WindowManager>; window: FakeWindow } {
  const manager = new WindowManager(dir)
  const window = manager.create('preload.js') as unknown as FakeWindow
  return { manager, window }
}

describe('window geometry', () => {
  it('writes once for a burst of resizes, with where the drag came to rest', () => {
    const { window } = open()
    const write = vi.spyOn(fs, 'writeFileSync')

    for (let width = 900; width <= 1000; width += 5) window.dragTo({ width })
    // Nothing on disk yet: the drag is still going.
    expect(fs.existsSync(file)).toBe(false)

    vi.advanceTimersByTime(1000)

    expect(saved().width).toBe(1000)
    // One temp file written, not one per event.
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('writes the last geometry straight away when the window closes', () => {
    const { window } = open()
    window.dragTo({ x: 120, y: 64, width: 1100, height: 700 })

    window.emit('close')

    expect(saved()).toMatchObject({ x: 120, y: 64, width: 1100, height: 700 })
  })

  it('keeps the restore size of a window that is maximized', () => {
    const { window } = open()
    window.dragTo({ x: 40, y: 40, width: 1024, height: 768 })
    vi.advanceTimersByTime(1000)

    window.maximize()
    // A maximized window reports the screen's bounds, not the user's size.
    window.dragTo({ x: 0, y: 0, width: 2560, height: 1400 })
    window.emit('close')

    expect(saved()).toMatchObject({ width: 1024, height: 768, maximized: true })
  })

  it('ignores a minimized window, which reports a position off every screen', () => {
    const { window } = open()
    window.dragTo({ x: 200, y: 100, width: 1200, height: 800 })
    vi.advanceTimersByTime(1000)

    window.minimized = true
    window.dragTo({ x: -32000, y: -32000 })
    vi.advanceTimersByTime(1000)

    expect(saved()).toMatchObject({ x: 200, y: 100 })
  })

  it('does not fail the app over geometry the filesystem will not take', () => {
    const { window } = open()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Nothing can be written, which on Windows is a scanner holding the file.
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })

    window.dragTo({ width: 1200 })
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(() => window.emit('close')).not.toThrow()
    expect(error).toHaveBeenCalled()
  })

  it('opens the next window from geometry that has not been written yet', () => {
    const { manager, window } = open()
    window.dragTo({ x: 300, y: 200, width: 1180, height: 720 })

    const second = manager.create('preload.js') as unknown as FakeWindow

    expect(second.getBounds()).toMatchObject({ width: 1180, height: 720 })
  })
})
