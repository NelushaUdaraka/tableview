/**
 * When TableView looks for a new release, and what it does with one.
 *
 * electron-updater does the fetching and the installing; what is ours is the
 * deciding. The ways that could go wrong are the ones worth catching: an
 * update fetched or installed that nobody wanted (the switch is off, or this
 * is the portable exe, which nothing can replace), an update that never
 * arrives because the checks stopped, and a failure that throws instead of
 * being said.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATE_ERRORS,
  UpdateController,
  describeUpdateError,
  updateMode
} from '../../src/main/updater'
import type { UpdateMode, UpdateState } from '../../src/shared/updates'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A release as electron-updater reads it out of `latest.yml`. */
function release(version: string): Record<string, unknown> {
  const file = `TableView-Setup-${version}.exe`
  return {
    version,
    files: [{ url: file, sha512: 'c2hhNTEy', size: 104_857_600 }],
    path: file,
    sha512: 'c2hhNTEy',
    releaseName: `TableView ${version}`,
    releaseNotes: '',
    releaseDate: '2026-10-19T09:00:00.000Z'
  }
}

/**
 * Stands in for electron-updater's `autoUpdater`, doing what it does with the
 * parts the controller touches: the same events in the same order, a check
 * that downloads on its own unless `autoDownload` is turned off, and an
 * install-on-quit that is only armed if it was wanted when the download
 * finished.
 */
class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  disableWebInstaller = false
  /** What GitHub would answer: the newest release, or why it cannot say. */
  latest: string | Error = '0.1.0'
  readonly current = '0.1.0'
  checks = 0
  downloads = 0
  readonly installs: [boolean | undefined, boolean | undefined][] = []
  /** Set to make the install fail on the spot, as replacing a read-only AppImage does. */
  installFailure: Error | null = null
  private quitHandlerAdded = false
  private download: { finish: () => void; fail: (error: Error) => void } | null = null

  async checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: unknown } | null> {
    this.checks += 1
    this.emit('checking-for-update')
    await Promise.resolve() // the request to GitHub
    const latest = this.latest
    if (latest instanceof Error) {
      this.emit('error', latest, String(latest.stack ?? latest))
      throw latest
    }
    const info = release(latest)
    const isUpdateAvailable = latest !== this.current
    this.emit(isUpdateAvailable ? 'update-available' : 'update-not-available', info)
    if (isUpdateAvailable && this.autoDownload) void this.downloadUpdate().catch(() => undefined)
    return { isUpdateAvailable, updateInfo: info }
  }

  downloadUpdate(): Promise<string[]> {
    this.downloads += 1
    const version = this.latest as string
    return new Promise((resolve, reject) => {
      this.download = {
        finish: () => {
          this.emit('update-downloaded', { ...release(version), downloadedFile: 'C:\\pending\\setup.exe' })
          if (this.autoInstallOnAppQuit) this.quitHandlerAdded = true
          resolve(['C:\\pending\\setup.exe'])
        },
        fail: (error) => {
          this.emit('error', error, String(error.stack ?? error))
          reject(error)
        }
      }
    })
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter])
    // electron-updater reports it there and then, and does not quit.
    const failure = this.installFailure
    if (failure) this.emit('error', failure, String(failure.stack ?? failure))
  }

  progress(percent: number): void {
    this.emit('download-progress', {
      total: 1000,
      delta: 10,
      transferred: percent * 10,
      percent,
      bytesPerSecond: 50_000
    })
  }

  finishDownload(): void {
    this.download?.finish()
    this.download = null
  }

  failDownload(error: Error): void {
    this.download?.fail(error)
    this.download = null
  }

  /** Whether quitting now would run the downloaded installer. */
  get installsOnQuit(): boolean {
    return this.quitHandlerAdded && this.autoInstallOnAppQuit
  }
}

function setup(options: { mode?: UpdateMode; enabled?: boolean } = {}): {
  updates: UpdateController
  fake: FakeUpdater
  changes: UpdateState[]
} {
  const fake = new FakeUpdater()
  const changes: UpdateState[] = []
  const updates = new UpdateController({
    mode: options.mode ?? 'self',
    enabled: options.enabled ?? true,
    updater: () => fake,
    onChange: (state) => changes.push(state)
  })
  return { updates, fake, changes }
}

/** Lets the promise chains the controller runs on catch up. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T09:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('which copies update themselves', () => {
  const windows = 'C:\\Users\\someone\\AppData\\Local\\Programs\\TableView\\TableView.exe'
  const deb = '/opt/TableView/tableview'
  /** What the AppImage runtime sets for the copy it mounted. */
  const appImage = {
    env: {
      APPIMAGE: '/home/someone/Applications/TableView-0.1.0-x64.AppImage',
      APPDIR: '/tmp/.mount_TableVq7Ld2X'
    },
    execPath: '/tmp/.mount_TableVq7Ld2X/tableview'
  }

  it('updates an installed Windows build in place', () => {
    expect(updateMode({ isPackaged: true, platform: 'win32', env: {}, execPath: windows })).toBe('self')
  })

  it('tells the portable exe apart by what its launcher sets', () => {
    const env = { PORTABLE_EXECUTABLE_DIR: 'D:\\Tools' }
    expect(
      updateMode({ isPackaged: true, platform: 'win32', env, execPath: 'C:\\Temp\\2x9\\TableView.exe' })
    ).toBe('notify')
  })

  it('replaces an AppImage, which says where it was run from', () => {
    expect(updateMode({ isPackaged: true, platform: 'linux', ...appImage })).toBe('self')
  })

  // The .deb build writes its marker into the folder the AppImage is packed
  // from, so an AppImage can carry one too.
  it('takes an AppImage for an AppImage, whatever marker is packed into it', () => {
    expect(updateMode({ isPackaged: true, platform: 'linux', ...appImage, packageType: 'deb' })).toBe(
      'self'
    )
  })

  // Started from an AppImage terminal, a .deb inherits the terminal's
  // variables; taking them for its own would replace the terminal's file.
  it('does not take the AppImage it was started from for its own', () => {
    const env = { APPIMAGE: '/home/someone/Applications/Terminal.AppImage', APPDIR: '/tmp/.mount_TermiK2' }
    expect(updateMode({ isPackaged: true, platform: 'linux', env, execPath: deb, packageType: 'deb' })).toBe(
      'notify'
    )
    expect(updateMode({ isPackaged: true, platform: 'linux', env, execPath: deb })).toBe('unsupported')
  })

  it('only says when a .deb has a newer release, leaving the install to its owner', () => {
    expect(updateMode({ isPackaged: true, platform: 'linux', env: {}, execPath: deb, packageType: 'deb' })).toBe(
      'notify'
    )
  })

  it('leaves development builds, macOS, and Linux packages no release is made as alone', () => {
    expect(updateMode({ isPackaged: false, platform: 'win32', env: {}, execPath: windows })).toBe('unsupported')
    expect(updateMode({ isPackaged: false, platform: 'linux', ...appImage })).toBe('unsupported')
    expect(
      updateMode({ isPackaged: true, platform: 'darwin', env: {}, execPath: '/Applications/TableView.app' })
    ).toBe('unsupported')
    expect(updateMode({ isPackaged: true, platform: 'linux', env: {}, execPath: deb })).toBe('unsupported')
    expect(
      updateMode({ isPackaged: true, platform: 'linux', env: {}, execPath: deb, packageType: 'rpm' })
    ).toBe('unsupported')
  })

  it('never wakes electron-updater in a build that cannot update', async () => {
    const updater = vi.fn(() => new FakeUpdater())
    const updates = new UpdateController({
      mode: 'unsupported',
      enabled: true,
      updater,
      onChange: () => undefined
    })
    updates.start()
    await vi.advanceTimersByTimeAsync(24 * HOUR)

    expect(await updates.check()).toEqual({ mode: 'unsupported', status: 'idle' })
    expect(updater).not.toHaveBeenCalled()
  })
})

describe('looking on its own', () => {
  it('looks soon after starting, then every four hours', async () => {
    const { updates, fake } = setup()
    updates.start()
    expect(fake.checks).toBe(0)

    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(fake.checks).toBe(1)

    await vi.advanceTimersByTimeAsync(4 * HOUR - 2 * MINUTE)
    expect(fake.checks).toBe(1)
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    expect(fake.checks).toBe(2)
  })

  it('never looks while automatic updates are off', async () => {
    const { updates, fake } = setup({ enabled: false })
    updates.start()
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(fake.checks).toBe(0)
  })

  it('stops looking when they are turned off, and looks at once when turned back on', async () => {
    const { updates, fake } = setup()
    updates.start()
    await vi.advanceTimersByTimeAsync(MINUTE)

    updates.setEnabled(false)
    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(fake.checks).toBe(1)

    updates.setEnabled(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.checks).toBe(2)
    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(fake.checks).toBe(3)
  })

  // A settings write can carry the switch's current value along with
  // whatever actually changed.
  it('keeps one schedule when told twice that updates are on', async () => {
    const { updates, fake } = setup()
    updates.start()
    await vi.advanceTimersByTimeAsync(MINUTE)

    updates.setEnabled(true)
    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(fake.checks).toBe(2)
  })

  it('says it is up to date, and when it last looked', async () => {
    const { updates } = setup()
    expect(await updates.check()).toEqual({
      mode: 'self',
      status: 'up-to-date',
      checkedAt: '2026-10-19T09:00:00.000Z'
    })
  })
})

describe('the installed app', () => {
  // Releases ship the full installer. A web installer's package is loaded
  // without the signature check the installer itself gets.
  it('never accepts a web installer', () => {
    const { fake } = setup()
    expect(fake.disableWebInstaller).toBe(true)
  })

  it('fetches a newer release in the background and says when it is ready', async () => {
    const { updates, fake, changes } = setup()
    fake.latest = '0.2.0'
    updates.start()
    await vi.advanceTimersByTimeAsync(MINUTE)

    expect(fake.downloads).toBe(1)
    expect(updates.state).toEqual({
      mode: 'self',
      status: 'downloading',
      version: '0.2.0',
      percent: 0
    })

    fake.progress(45.7)
    expect(updates.state.percent).toBe(45)

    fake.finishDownload()
    await flush()
    expect(updates.state).toEqual({ mode: 'self', status: 'ready', version: '0.2.0' })
    // The windows hear about it as well.
    expect(changes.at(-1)).toEqual({ mode: 'self', status: 'ready', version: '0.2.0' })
  })

  it('installs a fetched update on quit only while automatic updates are on', async () => {
    const { updates, fake } = setup()
    fake.latest = '0.2.0'
    updates.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    fake.finishDownload()
    await flush()
    expect(fake.installsOnQuit).toBe(true)

    updates.setEnabled(false)
    expect(fake.installsOnQuit).toBe(false)
  })

  it('fetches what someone asks for with automatic updates off, and installs it on quit', async () => {
    const { updates, fake } = setup({ enabled: false })
    fake.latest = '0.2.0'
    updates.start()

    expect(await updates.check()).toMatchObject({ status: 'downloading', version: '0.2.0' })
    fake.finishDownload()
    await flush()
    expect(fake.installsOnQuit).toBe(true)
  })

  // Switched off while a check was out: what it found is left alone, until
  // somebody asks for it.
  it('fetches a release it found but left alone, once somebody asks', async () => {
    const { updates, fake } = setup()
    fake.latest = '0.2.0'
    updates.start()
    vi.advanceTimersToNextTimer()
    updates.setEnabled(false)
    await flush()
    expect(updates.state).toEqual({ mode: 'self', status: 'available', version: '0.2.0' })
    expect(fake.downloads).toBe(0)

    expect(await updates.check()).toMatchObject({ status: 'downloading', version: '0.2.0' })
    expect(fake.downloads).toBe(1)
  })

  it('restarts into the update silently, and only once there is one', async () => {
    const { updates, fake } = setup()
    expect(updates.install()).toBe(false)

    fake.latest = '0.2.0'
    await updates.check()
    expect(updates.install()).toBe(false)
    fake.finishDownload()
    await flush()

    expect(updates.install()).toBe(true)
    // Silent, because the installer's own pages are for a first install; and
    // run afterwards, because the restart should end in the app.
    expect(fake.installs).toEqual([[true, true]])
  })

  it('says when the install fails on the spot, so nothing waits for a restart', async () => {
    const { updates, fake } = setup()
    fake.latest = '0.2.0'
    await updates.check()
    fake.finishDownload()
    await flush()

    fake.installFailure = coded("EACCES: permission denied, unlink '/opt/TableView-0.1.0-x64.AppImage'", 'EACCES')
    expect(updates.install()).toBe(false)
    expect(updates.state).toEqual({ mode: 'self', status: 'error', error: UPDATE_ERRORS.notWritable })
  })

  it('stops looking while an update waits to be installed', async () => {
    const { updates, fake } = setup()
    fake.latest = '0.2.0'
    updates.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    fake.finishDownload()
    await flush()

    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(await updates.check()).toMatchObject({ status: 'ready', version: '0.2.0' })
    expect(fake.checks).toBe(1)
  })

  it('reports a download that fails, and fetches it again at the next check', async () => {
    const { updates, fake } = setup()
    fake.latest = '0.2.0'
    updates.start()
    await vi.advanceTimersByTimeAsync(MINUTE)

    fake.failDownload(new Error('net::ERR_CONNECTION_RESET'))
    await flush()
    expect(updates.state).toEqual({ mode: 'self', status: 'error', error: UPDATE_ERRORS.offline })

    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(fake.downloads).toBe(2)
  })
})

describe('the portable exe', () => {
  it('only says that a newer release is out', async () => {
    const { updates, fake } = setup({ mode: 'notify' })
    fake.latest = '0.2.0'
    updates.start()
    await vi.advanceTimersByTimeAsync(MINUTE)

    expect(updates.state).toEqual({ mode: 'notify', status: 'available', version: '0.2.0' })
    expect(await updates.check()).toMatchObject({ status: 'available', version: '0.2.0' })
    expect(fake.downloads).toBe(0)
    expect(updates.install()).toBe(false)
  })
})

describe('a check that fails', () => {
  it('is reported in words, and the next one goes ahead', async () => {
    const { updates, fake } = setup()
    fake.latest = new Error('net::ERR_INTERNET_DISCONNECTED')
    updates.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(updates.state).toEqual({ mode: 'self', status: 'error', error: UPDATE_ERRORS.offline })

    fake.latest = '0.1.0'
    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(updates.state.status).toBe('up-to-date')
  })

  it('comes back as the answer to a check someone asked for, rather than a throw', async () => {
    const { updates, fake } = setup()
    fake.latest = coded('No published versions on GitHub', 'ERR_XML_MISSED_ELEMENT')
    expect(await updates.check()).toEqual({
      mode: 'self',
      status: 'error',
      error: UPDATE_ERRORS.noRelease
    })
  })
})

describe('describeUpdateError', () => {
  it.each([
    ['Electron could not connect', new Error('net::ERR_INTERNET_DISCONNECTED'), UPDATE_ERRORS.offline],
    [
      'GitHub could not be found',
      coded('getaddrinfo ENOTFOUND github.com', 'ENOTFOUND'),
      UPDATE_ERRORS.offline
    ],
    [
      'a lookup failed because the network did',
      coded(
        'Unable to find latest version on GitHub (https://github.com/NelushaUdaraka/tableview/releases/latest), please ensure a production release exists: Error: net::ERR_NAME_NOT_RESOLVED',
        'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
      ),
      UPDATE_ERRORS.offline
    ],
    [
      'the repository has no releases yet',
      coded('No published versions on GitHub', 'ERR_XML_MISSED_ELEMENT'),
      UPDATE_ERRORS.noRelease
    ],
    [
      'there is no release marked latest',
      coded(
        'Unable to find latest version on GitHub (https://github.com/NelushaUdaraka/tableview/releases/latest), please ensure a production release exists: HttpError: 404 Not Found',
        'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
      ),
      UPDATE_ERRORS.noRelease
    ],
    [
      'the releases cannot be seen, as for a private repository',
      Object.assign(coded('404 Not Found\nHeaders: {}', 'HTTP_ERROR_404'), { statusCode: 404 }),
      UPDATE_ERRORS.noRelease
    ],
    [
      'the release has no latest.yml',
      coded(
        'Cannot find latest.yml in the latest release artifacts (https://github.com/NelushaUdaraka/tableview/releases/download/v0.2.0/latest.yml): HttpError: 404',
        'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
      ),
      UPDATE_ERRORS.noUpdateFile
    ],
    [
      'the download came down damaged',
      coded('sha512 checksum mismatch, expected abc, got def', 'ERR_CHECKSUM_MISMATCH'),
      UPDATE_ERRORS.damaged
    ],
    [
      'the copy sits where it cannot be replaced',
      coded("EACCES: permission denied, unlink '/opt/TableView-0.1.0-x64.AppImage'", 'EACCES'),
      UPDATE_ERRORS.notWritable
    ],
    [
      'the file is held or protected',
      coded("EPERM: operation not permitted, rename '/tmp/update.AppImage'", 'EPERM'),
      UPDATE_ERRORS.notWritable
    ],
    [
      'the installer is signed by somebody else',
      coded('New version 0.2.0 is not signed by the application owner: publisherNames: TableView', 'ERR_UPDATER_INVALID_SIGNATURE'),
      UPDATE_ERRORS.unsigned
    ]
  ])('says so when %s', (_case, error, expected) => {
    expect(describeUpdateError(error)).toBe(expected)
  })

  it("passes anything else on in electron-updater's words, without the stack", () => {
    const error = new Error('Something unexpected\n    at doCheckForUpdates (AppUpdater.js:400:14)')
    expect(describeUpdateError(error)).toBe('Something unexpected')
    expect(describeUpdateError('boom')).toBe('boom')
  })
})
