/**
 * The IPC façade the renderer should use instead of `window.api` directly.
 *
 * `contextBridge` copies arguments across the isolated-world boundary with the
 * structured clone algorithm, and that algorithm refuses to clone a Proxy —
 * which is exactly what Vue's reactive state is. Passing a `ref`'d array
 * straight to `window.api` therefore fails with "An object could not be
 * cloned" before any of our preload code runs. Converting arguments to plain
 * data here fixes it once, for every call site.
 */
import type { RendererApi } from '@shared/ipc'
import { toPlain } from '@shared/ipcSerialize'

type ApiFunction = (...args: unknown[]) => unknown

export const api: RendererApi = new Proxy({} as RendererApi, {
  get(_target, property: string) {
    const value = (window.api as unknown as Record<string, unknown>)[property]
    if (typeof value !== 'function') return value
    return (...args: unknown[]) => (value as ApiFunction)(...args.map(toPlain))
  }
})
