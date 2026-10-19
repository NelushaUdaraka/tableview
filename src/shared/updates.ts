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
 * `installed` is the NSIS install, which a newer installer replaces in place.
 * `portable` is the single exe, which nothing can swap out from under itself:
 * it is told about a newer release and the download is left to the reader.
 * `unsupported` is a development build, or a platform no release is built for.
 */
export type UpdateMode = 'installed' | 'portable' | 'unsupported'

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
