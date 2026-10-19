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

let nextId = 1

export const useToastStore = defineStore('toasts', () => {
  const toasts = ref<Toast[]>([])

  function push(
    kind: Toast['kind'],
    message: string,
    detail?: string,
    options: { action?: ToastAction } = {}
  ): number {
    const id = nextId++
    toasts.value = [...toasts.value, { id, kind, message, detail, action: options.action }]
    // Errors stay until dismissed, and so does a toast with something to do:
    // a button that fades before it can be reached is no button at all. The
    // rest fade on their own.
    if (kind !== 'error' && !options.action) setTimeout(() => dismiss(id), 4000)
    return id
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
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

  return { toasts, push, dismiss, act, info, success, error, fromError }
})
