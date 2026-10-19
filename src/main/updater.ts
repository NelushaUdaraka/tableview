/**
 * Keeping TableView up to date.
 *
 * The release workflow publishes each version to GitHub, and electron-updater
 * reads them from there. What is decided here is when to look, what to do with
 * what turns up, and what the windows are told about it:
 *
 * - The installed app looks shortly after it starts and every four hours after
 *   that, fetches a newer release in the background, and installs it on
 *   restart — or on quit, for whoever never gets round to restarting.
 * - The portable exe looks just as often but only says what it found. Nothing
 *   can replace the exe it is running from, so the download is the reader's.
 * - With automatic updates off nothing is looked for or fetched unasked. A
 *   check somebody asks for still goes ahead, and what it finds is fetched and
 *   installed like any other update: asking was the point.
 *
 * Once an update is waiting on somebody — to be fetched, or to be installed —
 * the scheduled checks stand down. There is nothing more to learn until it has
 * been dealt with, and asking again every four hours would only raise the same
 * news again.
 *
 * electron-updater is handed in rather than imported, so that a development
 * build never wakes it and the tests can stand in for it.
 */
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import type { UpdateMode, UpdateState } from '../shared/updates'

/** The part of electron-updater's `autoUpdater` this uses. */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  disableWebInstaller: boolean
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available' | 'update-not-available', listener: (info: UpdateInfo) => void): unknown
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): unknown
  on(event: 'update-downloaded', listener: (event: UpdateDownloadedEvent) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

/** How long after start-up the first look waits, so it is not in start-up's way. */
const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * Which kind of copy this is.
 *
 * Releases are only built for Windows, and a development build has no
 * installed copy to replace. The portable exe is told apart by its launcher,
 * which unpacks the app somewhere temporary and says where it was run from.
 */
export function updateMode(app: {
  isPackaged: boolean
  platform: string
  env: Record<string, string | undefined>
}): UpdateMode {
  if (!app.isPackaged || app.platform !== 'win32') return 'unsupported'
  return app.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed'
}

/** What a failure is called, for the failures worth naming. */
export const UPDATE_ERRORS = {
  offline: 'Could not reach GitHub. Check the connection and try again.',
  noRelease: 'GitHub has no published release of TableView yet.',
  noUpdateFile: 'The latest release on GitHub is missing its update file.',
  damaged: 'The update did not download intact. Try again.',
  unsigned: 'The update is not signed by TableView’s publisher, so it was not installed.'
} as const

const OFFLINE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH'
])

/**
 * A failure in words.
 *
 * electron-updater's own messages carry a URL, a stack and as often as not a
 * dump of response headers. The failures somebody can do something about get a
 * sentence of their own; the rest are passed on as the first line of what
 * electron-updater said.
 */
export function describeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | null)?.code

  // Checked before the codes: a lookup that fails because the network did is
  // reported under the lookup's code.
  if (message.includes('net::ERR_') || (typeof code === 'string' && OFFLINE_CODES.has(code))) {
    return UPDATE_ERRORS.offline
  }
  switch (code) {
    // No releases at all, none marked latest, or none visible: GitHub answers
    // a private repository's feed with a 404.
    case 'ERR_UPDATER_NO_PUBLISHED_VERSIONS':
    case 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND':
    case 'HTTP_ERROR_404':
      return UPDATE_ERRORS.noRelease
    case 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND':
      return UPDATE_ERRORS.noUpdateFile
    case 'ERR_CHECKSUM_MISMATCH':
      return UPDATE_ERRORS.damaged
    case 'ERR_UPDATER_INVALID_SIGNATURE':
      return UPDATE_ERRORS.unsigned
  }
  // An empty feed has no code of its own, only the missing element's.
  if (message.startsWith('No published versions')) return UPDATE_ERRORS.noRelease

  const firstLine = message.split('\n')[0].trim()
  return firstLine || 'The update failed.'
}

export interface UpdateControllerOptions {
  mode: UpdateMode
  /** The `autoUpdate` setting, as it stands at start-up. */
  enabled: boolean
  /** Only called for a copy that can update: see the note at the top. */
  updater: () => Updater
  /** Told every time the state changes, to pass on to the windows. */
  onChange: (state: UpdateState) => void
}

export class UpdateController {
  private readonly mode: UpdateMode
  private readonly updater: Updater | null
  private readonly onChange: (state: UpdateState) => void
  private enabled: boolean
  private current: UpdateState
  /** The first look after start-up, or after updates are switched on. */
  private firstCheck: ReturnType<typeof setTimeout> | null = null
  private everyFewHours: ReturnType<typeof setInterval> | null = null
  /**
   * The waiting download was asked for, so it installs on quit whatever the
   * switch says.
   */
  private asked = false

  constructor(options: UpdateControllerOptions) {
    this.mode = options.mode
    this.enabled = options.enabled
    this.onChange = options.onChange
    this.current = { mode: options.mode, status: 'idle' }
    this.updater = options.mode === 'unsupported' ? null : options.updater()
    if (!this.updater) return

    // Fetching is decided here, not by electron-updater: the portable exe
    // must never fetch the installer, and the switch has a say for the rest.
    this.updater.autoDownload = false
    // Releases carry the whole installer, never a web installer — whose
    // package would be loaded without the installer's signature check.
    this.updater.disableWebInstaller = true
    this.syncInstallOnQuit()

    this.updater.on('checking-for-update', () => this.set({ status: 'checking' }))
    this.updater.on('update-not-available', () =>
      this.set({ status: 'up-to-date', checkedAt: new Date().toISOString() })
    )
    this.updater.on('update-available', (info) =>
      this.set({ status: 'available', version: info.version })
    )
    this.updater.on('download-progress', (progress) =>
      this.set({
        status: 'downloading',
        version: this.current.version,
        percent: Math.floor(progress.percent)
      })
    )
    this.updater.on('update-downloaded', (event) =>
      this.set({ status: 'ready', version: event.version })
    )
    // Every failure, of a check or of a download, arrives here as well as in
    // the promise that failed — and an updater with no listener for it would
    // throw it instead.
    this.updater.on('error', (error) => this.set({ status: 'error', error: describeUpdateError(error) }))
  }

  get state(): UpdateState {
    return this.current
  }

  /** Begins the scheduled checks, if updates are on. */
  start(): void {
    if (this.enabled) this.schedule(FIRST_CHECK_DELAY_MS)
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.syncInstallOnQuit()
    // Turned on, it looks at once: somebody has just said they want updates.
    if (enabled) this.schedule(0)
    else this.unschedule()
  }

  /**
   * A check somebody asked for. It goes ahead whatever the switch says, and
   * what it finds is fetched; the answer is the state it leaves behind,
   * failures included.
   */
  async check(): Promise<UpdateState> {
    if (!this.updater) return this.current
    // Found by a check that was not to fetch it — the switch went off while it
    // was out — and asked for now.
    if (this.current.status === 'available' && this.mode === 'installed') {
      this.fetch(true)
      return this.current
    }
    if (this.isWaiting()) return this.current
    await this.look(true)
    return this.current
  }

  /**
   * Restarts into the downloaded update: silently, since the installer's
   * pages are for a first install, and running the app again afterwards.
   * False when there is nothing to install.
   */
  install(): boolean {
    if (!this.updater || this.current.status !== 'ready') return false
    this.updater.quitAndInstall(true, true)
    return true
  }

  private async look(asked: boolean): Promise<void> {
    if (!this.updater) return
    let found = false
    try {
      found = (await this.updater.checkForUpdates())?.isUpdateAvailable === true
    } catch {
      // Already reported through the updater's `error` event.
      return
    }
    if (found && this.mode === 'installed' && (asked || this.enabled)) this.fetch(asked)
  }

  private fetch(asked: boolean): void {
    if (!this.updater) return
    if (asked) this.asked = true
    // Settled before the download is done: that is when electron-updater
    // decides whether to install on quit.
    this.syncInstallOnQuit()
    if (this.current.status === 'downloading') return
    this.set({ status: 'downloading', version: this.current.version, percent: 0 })
    this.updater.downloadUpdate().catch(() => {
      // Already reported through the updater's `error` event.
    })
  }

  private syncInstallOnQuit(): void {
    if (!this.updater) return
    this.updater.autoInstallOnAppQuit = this.mode === 'installed' && (this.enabled || this.asked)
  }

  /** An update has been found and is waiting on somebody. */
  private isWaiting(): boolean {
    const { status } = this.current
    return status === 'available' || status === 'downloading' || status === 'ready'
  }

  private schedule(delay: number): void {
    this.unschedule()
    const scheduled = (): void => {
      if (!this.isWaiting() && this.current.status !== 'checking') void this.look(false)
    }
    this.firstCheck = setTimeout(() => {
      this.firstCheck = null
      scheduled()
      this.everyFewHours = setInterval(scheduled, CHECK_INTERVAL_MS)
      // An update check should never be what holds the process open.
      this.everyFewHours.unref?.()
    }, delay)
    this.firstCheck.unref?.()
  }

  private unschedule(): void {
    if (this.firstCheck) clearTimeout(this.firstCheck)
    if (this.everyFewHours) clearInterval(this.everyFewHours)
    this.firstCheck = null
    this.everyFewHours = null
  }

  private set(next: Omit<UpdateState, 'mode'>): void {
    const state: UpdateState = { mode: this.mode, ...next }
    // Undefined fields are left off, so the state reads the same whichever
    // way it was arrived at — and an identical one is not news.
    for (const key of Object.keys(state) as (keyof UpdateState)[]) {
      if (state[key] === undefined) delete state[key]
    }
    if (JSON.stringify(state) === JSON.stringify(this.current)) return
    this.current = state
    this.onChange(state)
  }
}
