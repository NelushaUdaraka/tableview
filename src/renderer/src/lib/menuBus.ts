/**
 * One delivery point for menu actions.
 *
 * They arrive from two places — the native menu, over IPC, and the title bar's
 * own copy of the menu, which lives in this page — and the views that act on
 * them should not have to care which. `App.vue` forwards the IPC stream in
 * here; everything else subscribes to this.
 */
import type { MenuAction } from '@shared/menu'

type Handler = (action: MenuAction) => void

const handlers = new Set<Handler>()

export function onMenuAction(handler: Handler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

export function dispatchMenuAction(action: MenuAction): void {
  // Copied first: a handler is allowed to unsubscribe while it runs.
  for (const handler of [...handlers]) handler(action)
}
