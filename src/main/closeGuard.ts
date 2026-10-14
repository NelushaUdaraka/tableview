/**
 * Holds a window's close — and the app's quit — while the window has work
 * that has not been saved, and asks the window about it first.
 *
 * Only the renderer knows what is unsaved: a table's staged edits live in its
 * view, a routine's changes on its tab. So the renderer says whenever that
 * changes and the guard keeps the answer; a window that has said nothing, has
 * crashed, or is reloading closes exactly as it always did.
 *
 * Quitting is asked about on its own. With connections open, the app exits
 * outright once its pools are closed (see index.ts), so no window gets a
 * close event to be held by.
 */
import type { BrowserWindow } from 'electron'
import { CHANNELS, type WindowCloseReason } from '../shared/ipc'

interface Question {
  answered: Promise<boolean>
  resolve: (proceed: boolean) => void
}

export class CloseGuard {
  /** Windows whose renderer says they hold unsaved work. */
  private readonly unsaved = new Set<BrowserWindow>()
  /** Windows that have said yes, and are on their way out. */
  private readonly approved = new Set<BrowserWindow>()
  /** Windows that have been asked and have not answered yet. */
  private readonly asking = new Map<BrowserWindow, Question>()
  /** A quit is waiting on its answers. */
  private quitting = false
  /** Every window asked has said yes: the app is on its way out. */
  private quitApproved = false

  /** Holds `window`'s close for as long as it has unsaved work. */
  watch(window: BrowserWindow): void {
    window.on('close', (event) => {
      if (this.quitApproved || this.approved.has(window) || !this.unsaved.has(window)) return
      event.preventDefault()
      void this.ask(window, 'close-window').then((proceed) => {
        if (!proceed || window.isDestroyed()) return
        this.approved.add(window)
        window.close()
      })
    })
    // A page that reloads, or whose renderer dies, has lost whatever it was
    // holding: there is nothing left to ask about, and a question already
    // asked will never be answered.
    window.webContents.on('did-start-loading', () => this.forget(window))
    window.webContents.on('render-process-gone', () => this.forget(window))
    window.on('closed', () => {
      this.forget(window)
      this.approved.delete(window)
    })
  }

  /** What a window's renderer says about its own work. */
  setUnsaved(window: BrowserWindow, unsaved: boolean): void {
    if (unsaved) this.unsaved.add(window)
    else this.unsaved.delete(window)
  }

  /** A window's answer to the question it was asked: true to go ahead. */
  answer(window: BrowserWindow, proceed: boolean): void {
    const question = this.asking.get(window)
    this.asking.delete(window)
    question?.resolve(proceed)
  }

  /**
   * Whether the app may quit now.
   *
   * When windows hold unsaved work, they are asked in turn — each brought to
   * the front first, since that is where its answer is — and `quit` is called
   * again once every one has said yes. The first no ends it: nothing closes,
   * and the next quit asks again.
   */
  mayQuit(windows: BrowserWindow[], quit: () => void): boolean {
    if (this.quitApproved) return true
    const holding = windows.filter((window) => !window.isDestroyed() && this.unsaved.has(window))
    if (holding.length === 0) return true
    if (!this.quitting) {
      this.quitting = true
      void this.askInTurn(holding).then((proceed) => {
        this.quitting = false
        if (!proceed) return
        this.quitApproved = true
        quit()
      })
    }
    return false
  }

  private async askInTurn(windows: BrowserWindow[]): Promise<boolean> {
    for (const window of windows) {
      // Answered for already: closed, or reloaded, while an earlier one was asked.
      if (window.isDestroyed() || !this.unsaved.has(window)) continue
      if (!(await this.ask(window, 'quit'))) return false
    }
    return true
  }

  private ask(window: BrowserWindow, reason: WindowCloseReason): Promise<boolean> {
    // Asked already: the question on screen answers this one as well.
    const pending = this.asking.get(window)
    if (pending) return pending.answered

    let resolve: (proceed: boolean) => void = () => undefined
    const answered = new Promise<boolean>((done) => {
      resolve = done
    })
    this.asking.set(window, { answered, resolve })

    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    window.webContents.send(CHANNELS.eventCloseRequested, reason)
    return answered
  }

  /** Lets go of a window that has nothing left to ask about. */
  private forget(window: BrowserWindow): void {
    this.unsaved.delete(window)
    // Its work has gone, so whatever was waiting on its answer may go ahead.
    this.answer(window, true)
  }
}

/** The one guard, shared by the window factory, the quit and the IPC handlers. */
export const closeGuard = new CloseGuard()
