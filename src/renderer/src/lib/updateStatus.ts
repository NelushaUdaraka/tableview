/**
 * The Settings dialog's line about updating, and the one button beside it.
 *
 * The button is always the next step and never more than one: look for an
 * update, fetch one that was found, restart into one that is ready — or, for
 * a copy that does not install updates itself (the portable exe, the .deb),
 * go and download it.
 */
import type { UpdateState } from '@shared/updates'

export type UpdateAction = 'check' | 'get' | 'restart' | 'download'

export const UPDATE_ACTION_LABELS: Record<UpdateAction, string> = {
  check: 'Check now',
  get: 'Get update',
  restart: 'Restart to update',
  download: 'Download'
}

/** What the button does next; nothing, for a copy that does not update itself. */
export function nextUpdateAction(state: UpdateState): UpdateAction | null {
  if (state.mode === 'unsupported') return null
  if (state.status === 'ready') return 'restart'
  if (state.status === 'available') return state.mode === 'notify' ? 'download' : 'get'
  return 'check'
}

/** A check or a download is under way: pressing again would change nothing. */
export function updateInProgress(state: UpdateState): boolean {
  return state.status === 'checking' || state.status === 'downloading'
}

/** Where updating stands, in a line. */
export function updateSummary(state: UpdateState): string {
  if (state.mode === 'unsupported') {
    return 'This build does not update itself. Copies downloaded from a TableView release do.'
  }
  switch (state.status) {
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return state.checkedAt
        ? `Up to date. Last checked at ${formatTime(state.checkedAt)}.`
        : 'Up to date.'
    case 'available':
      return `TableView ${state.version} is available.`
    case 'downloading':
      return `Downloading TableView ${state.version}… ${state.percent ?? 0}%`
    case 'ready':
      return `TableView ${state.version} is ready to install.`
    case 'error':
      return state.error ?? 'The last check failed.'
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
