import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Something a toast offers to do, drawn as a button on it. */
export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
  detail?: string
  action?: ToastAction
}

/** How long a toast stays: an error longer, since it usually has more to say. */
const LIFETIME_MS: Record<Toast['kind'], number> = { info: 4000, success: 4000, error: 8000 }

let nextId = 1

export const useToastStore = defineStore('toasts', () => {
  const toasts = ref<Toast[]>([])
  /** Each toast's countdown to its own dismissal, while one is running. */
  const countdowns = new Map<number, ReturnType<typeof setTimeout>>()
  /** The toast the pointer rests on, while it rests on one. */
  let heldBy: number | null = null

  /**
   * Starts a toast counting down to its own dismissal.
   *
   * A toast with something to do stays until it is taken up or dismissed: a
   * button that fades before it can be reached is no button at all.
   */
  function countDown(toast: Toast): void {
    if (toast.action) return
    clearTimeout(countdowns.get(toast.id))
    countdowns.set(toast.id, setTimeout(() => dismiss(toast.id), LIFETIME_MS[toast.kind]))
  }

  function push(
    kind: Toast['kind'],
    message: string,
    detail?: string,
    options: { action?: ToastAction } = {}
  ): number {
    const id = nextId++
    const toast: Toast = { id, kind, message, detail, action: options.action }
    toasts.value = [...toasts.value, toast]
    if (heldBy === null) countDown(toast)
    return id
  }

  function dismiss(id: number): void {
    clearTimeout(countdowns.get(id))
    countdowns.delete(id)
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
    // Taken away from under the pointer, a toast never hears it leave.
    release(id)
  }

  /**
   * The pointer has come to rest on a toast, and none of them goes while it is
   * there — not only that one: the column is anchored at the bottom, so any
   * toast below it going would move it out from under the pointer.
   */
  function hold(id: number): void {
    heldBy = id
    for (const countdown of countdowns.values()) clearTimeout(countdown)
    countdowns.clear()
  }

  /** The pointer has left a toast: they all count down again, from the start. */
  function release(id: number): void {
    if (heldBy !== id) return
    heldBy = null
    for (const toast of toasts.value) countDown(toast)
  }

  /** Does what a toast offers, and puts the toast away: it has been answered. */
  function act(id: number): void {
    const toast = toasts.value.find((entry) => entry.id === id)
    if (!toast?.action) return
    dismiss(id)
    toast.action.run()
  }

  const info = (message: string, detail?: string): number => push('info', message, detail)
  const success = (message: string, detail?: string): number => push('success', message, detail)
  const error = (message: string, detail?: string): number => push('error', message, detail)

  /** Reports a caught error without the caller repeating the unwrapping. */
  function fromError(context: string, err: unknown): number {
    const message = err instanceof Error ? err.message : String(err)
    return push('error', context, message)
  }

  return { toasts, push, dismiss, act, hold, release, info, success, error, fromError }
})
