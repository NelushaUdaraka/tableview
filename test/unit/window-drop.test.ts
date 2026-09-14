/**
 * Which window a dragged-out tab was let go over.
 *
 * A drag never leaves the document it started in, so a renderer cannot see the
 * window next to it: all it can report is where the pointer was when the tab
 * was dropped. Turning that point back into a window is the manager's job, and
 * where windows overlap there is no z-order to ask Electron for — the most
 * recently focused one is taken to be the one on top, because raising a window
 * is what focuses it.
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

  /** Clicking a window raises it, which is the order `windowAt` goes by. */
  focus(): void {
    this.emit('focus')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  isMaximized(): boolean {
    return false
  }
  isFullScreen(): boolean {
    return false
  }
  isFocused(): boolean {
    return true
  }
  maximize(): void {}
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
let manager: InstanceType<typeof WindowManager>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-drop-'))
  manager = new WindowManager(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Opens a window and puts it where the test wants it. */
function open(bounds: Bounds): FakeWindow {
  const window = manager.create('preload.js') as unknown as FakeWindow
  window.bounds = { ...bounds }
  return window
}

describe('windowAt', () => {
  it('names the window the pointer was over', () => {
    const left = open({ x: 0, y: 0, width: 800, height: 600 })
    const right = open({ x: 900, y: 0, width: 800, height: 600 })

    expect(manager.windowAt({ x: 1200, y: 300 })).toBe(right as never)
    expect(manager.windowAt({ x: 400, y: 300 })).toBe(left as never)
  })

  it('never names the window the tab came from', () => {
    const source = open({ x: 0, y: 0, width: 800, height: 600 })

    // Dropped back over its own frame, which the strip has already had its say
    // about: there is no other window there, so this is a detach.
    expect(manager.windowAt({ x: 400, y: 300 }, source as never)).toBeNull()
  })

  it('finds nothing where there is no window, so the tab gets one of its own', () => {
    open({ x: 0, y: 0, width: 800, height: 600 })

    expect(manager.windowAt({ x: 1800, y: 900 })).toBeNull()
  })

  it('gives an overlap to the window that was focused last', () => {
    const under = open({ x: 0, y: 0, width: 1000, height: 800 })
    const over = open({ x: 200, y: 100, width: 1000, height: 800 })

    expect(manager.windowAt({ x: 500, y: 400 })).toBe(over as never)

    under.focus()

    expect(manager.windowAt({ x: 500, y: 400 })).toBe(under as never)
  })

  it('passes over a minimized window, whatever bounds it reports', () => {
    const minimized = open({ x: 0, y: 0, width: 800, height: 600 })
    minimized.minimized = true

    expect(manager.windowAt({ x: 400, y: 300 })).toBeNull()
  })

  it('forgets a window once it has closed', () => {
    const window = open({ x: 0, y: 0, width: 800, height: 600 })

    window.destroyed = true
    window.emit('closed')

    expect(manager.windowAt({ x: 400, y: 300 })).toBeNull()
  })
})
