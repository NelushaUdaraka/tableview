import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
  detail?: string
}

let nextId = 1

export const useToastStore = defineStore('toasts', () => {
  const toasts = ref<Toast[]>([])

  function push(kind: Toast['kind'], message: string, detail?: string): number {
    const id = nextId++
    toasts.value = [...toasts.value, { id, kind, message, detail }]
    // Errors stay until dismissed; the rest fade on their own.
    if (kind !== 'error') setTimeout(() => dismiss(id), 4000)
    return id
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
  }

  const info = (message: string, detail?: string): number => push('info', message, detail)
  const success = (message: string, detail?: string): number => push('success', message, detail)
  const error = (message: string, detail?: string): number => push('error', message, detail)

  /** Reports a caught error without the caller repeating the unwrapping. */
  function fromError(context: string, err: unknown): number {
    const message = err instanceof Error ? err.message : String(err)
    return push('error', context, message)
  }

  return { toasts, push, dismiss, info, success, error, fromError }
})
