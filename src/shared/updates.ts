/**
 * Updating TableView, as both sides see it.
 *
 * The main process does the updating (`main/updater.ts`); the windows say how
 * it is going and offer what can be done next. This is what passes between
 * them.
 */

/**
 * How this copy can be brought up to date.
 *
 * `self`: it installs a newer release itself — the Windows install, which a
 * newer installer replaces in place, and the AppImage, which swaps its own
 * file for the new one.
 * `notify`: it is told about a newer release and the download is left to the
 * reader — the portable exe, which nothing can swap out from under itself, and
 * the .deb, whose installs are its owner's to make.
 * `unsupported`: a development build, or a package no release is made as.
 */
export type UpdateMode = 'self' | 'notify' | 'unsupported'

export type UpdateStatus =
  /** Nothing has been looked for yet. */
  | 'idle'
  | 'checking'
  | 'up-to-date'
  /** A newer release exists and has not been fetched. */
  | 'available'
  | 'downloading'
  /** Fetched: it installs on restart, or on quit. */
  | 'ready'
  /**
   * Restarting into it: the app is about to close, and opens again once the
   * update is in. Said first, so the window going is not taken for a crash.
   */
  | 'installing'
  | 'error'

export interface UpdateState {
  mode: UpdateMode
  status: UpdateStatus
  /** The newer release, from `available` on. */
  version?: string
  /** How much of it has arrived, 0–100, while `downloading`. */
  percent?: number
  /** What went wrong, in words, when `error`. */
  error?: string
  /** When the last check found nothing newer, as an ISO timestamp. */
  checkedAt?: string
}

/**
 * Where releases are published. The `publish` section of electron-builder.yml
 * names the same repository; the two have to agree.
 */
export const RELEASES_URL = 'https://github.com/NelushaUdaraka/tableview/releases'

/** The page a release is downloaded from. */
export function releasePage(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`
}
