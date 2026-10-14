/**
 * A window's close, and the app's quit, held while a window has unsaved work.
 *
 * The renderer knows what is unsaved and says so; the guard holds the close
 * and asks. What matters most is the two ways it could go wrong: a window
 * with work in it closing without a question, and a window that can never
 * close at all — because nothing will ever answer the question it was asked.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { CloseGuard } from '../../src/main/closeGuard'
import { CHANNELS } from '../../src/shared/ipc'

/** Just enough of a BrowserWindow for the guard: a close that can be held. */
class FakeWindow extends EventEmitter {
  destroyed = false
  minimized = false
  focused = 0
  readonly sent: unknown[][] = []
  readonly webContents = Object.assign(new EventEmitter(), {
    send: (...args: unknown[]): void => {
      this.sent.push(args)
    }
  })

  /** What Electron does: a close event that may be prevented, then gone. */
  close(): void {
    let prevented = false
    this.emit('close', { preventDefault: () => (prevented = true) })
    if (prevented) return
    this.destroyed = true
    this.emit('closed')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  restore(): void {
    this.minimized = false
  }
  show(): void {}
  focus(): void {
    this.focused += 1
  }

  /** The questions the renderer was asked, by reason. */
  get asked(): unknown[] {
    return this.sent
      .filter(([channel]) => channel === CHANNELS.eventCloseRequested)
      .map(([, reason]) => reason)
  }
}

const real = (window: FakeWindow): BrowserWindow => window as unknown as BrowserWindow

function watched(guard = new CloseGuard()): { guard: CloseGuard; window: FakeWindow } {
  const window = new FakeWindow()
  guard.watch(real(window))
  return { guard, window }
}

/** Lets the promise chain the guard runs on catch up. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('closing a window', () => {
  it('closes a window with nothing unsaved straight away, asking nothing', () => {
    const { window } = watched()
    window.close()
    expect(window.destroyed).toBe(true)
    expect(window.asked).toEqual([])
  })

  it('holds a window with unsaved work and asks it', () => {
    const { guard, window } = watched()
    guard.setUnsaved(real(window), true)
    window.close()
    expect(window.destroyed).toBe(false)
    expect(window.asked).toEqual(['close-window'])
  })

  it('stays open when told no, and asks again next time', async () => {
    const { guard, window } = watched()
    guard.setUnsaved(real(window), true)
    window.close()
    guard.answer(real(window), false)
    await settle()
    expect(window.destroyed).toBe(false)

    window.close()
    expect(window.asked).toEqual(['close-window', 'close-window'])
  })

  it('closes when told yes', async () => {
    const { guard, window } = watched()
    guard.setUnsaved(real(window), true)
    window.close()
    guard.answer(real(window), true)
    await settle()
    expect(window.destroyed).toBe(true)
  })

  it('asks once, however many times close is clicked while it waits', async () => {
    const { guard, window } = watched()
    guard.setUnsaved(real(window), true)
    window.close()
    window.close()
    window.close()
    expect(window.asked).toEqual(['close-window'])
    guard.answer(real(window), true)
    await settle()
    expect(window.destroyed).toBe(true)
  })

  it('closes as before once the renderer says its work is saved', () => {
    const { guard, window } = watched()
    guard.setUnsaved(real(window), true)
    guard.setUnsaved(real(window), false)
    window.close()
    expect(window.destroyed).toBe(true)
  })

  it('forgets the work of a page that reloads', () => {
    const { guard, window } = watched()
    guard.setUnsaved(real(window), true)
    window.webContents.emit('did-start-loading')
    window.close()
    expect(window.destroyed).toBe(true)
  })

  it('lets a window close whose renderer died while it was being asked', async () => {
    const { guard, window } = watched()
    guard.setUnsaved(real(window), true)
    window.close()
    window.webContents.emit('render-process-gone')
    await settle()
    expect(window.destroyed).toBe(true)
  })

  it('ignores an answer nobody asked for', () => {
    const { guard, window } = watched()
    expect(() => guard.answer(real(window), true)).not.toThrow()
    expect(window.destroyed).toBe(false)
  })

  it('brings a minimised window back before asking it', () => {
    const { guard, window } = watched()
    guard.setUnsaved(real(window), true)
    window.minimized = true
    window.close()
    expect(window.minimized).toBe(false)
    expect(window.focused).toBe(1)
  })
})

describe('quitting', () => {
  it('quits straight away when no window holds unsaved work', () => {
    const { guard, window } = watched()
    const quit = vi.fn()
    expect(guard.mayQuit([real(window)], quit)).toBe(true)
    expect(window.asked).toEqual([])
    expect(quit).not.toHaveBeenCalled()
  })

  it('asks each window holding work in turn, then quits again', async () => {
    const guard = new CloseGuard()
    const first = watched(guard).window
    const clean = watched(guard).window
    const second = watched(guard).window
    guard.setUnsaved(real(first), true)
    guard.setUnsaved(real(second), true)
    const quit = vi.fn()

    expect(guard.mayQuit([real(first), real(clean), real(second)], quit)).toBe(false)
    expect(first.asked).toEqual(['quit'])
    // One at a time: the second is not asked until the first has answered.
    expect(second.asked).toEqual([])

    guard.answer(real(first), true)
    await settle()
    expect(second.asked).toEqual(['quit'])
    expect(clean.asked).toEqual([])

    guard.answer(real(second), true)
    await settle()
    expect(quit).toHaveBeenCalledTimes(1)
    // The quit that follows goes straight through, and so do the windows.
    expect(guard.mayQuit([real(first), real(second)], quit)).toBe(true)
    first.close()
    expect(first.destroyed).toBe(true)
  })

  it('stops at the first no, and asks again on the next quit', async () => {
    const guard = new CloseGuard()
    const first = watched(guard).window
    const second = watched(guard).window
    guard.setUnsaved(real(first), true)
    guard.setUnsaved(real(second), true)
    const quit = vi.fn()

    guard.mayQuit([real(first), real(second)], quit)
    guard.answer(real(first), false)
    await settle()
    expect(second.asked).toEqual([])
    expect(quit).not.toHaveBeenCalled()

    expect(guard.mayQuit([real(first), real(second)], quit)).toBe(false)
    expect(first.asked).toEqual(['quit', 'quit'])
  })

  it('does not ask twice when quit is asked for again while it waits', () => {
    const { guard, window } = watched()
    guard.setUnsaved(real(window), true)
    const quit = vi.fn()
    guard.mayQuit([real(window)], quit)
    guard.mayQuit([real(window)], quit)
    expect(window.asked).toEqual(['quit'])
  })

  it('skips a window that closed while an earlier one was being asked', async () => {
    const guard = new CloseGuard()
    const first = watched(guard).window
    const second = watched(guard).window
    guard.setUnsaved(real(first), true)
    guard.setUnsaved(real(second), true)
    const quit = vi.fn()

    guard.mayQuit([real(first), real(second)], quit)
    // The second's renderer reloads, so its work is gone, before its turn.
    second.webContents.emit('did-start-loading')
    guard.answer(real(first), true)
    await settle()
    expect(second.asked).toEqual([])
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
