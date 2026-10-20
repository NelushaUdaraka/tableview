/**
 * What a window says about updating, and when.
 *
 * The main process decides everything; the window decides what is worth
 * interrupting the reader for. An update ready to install is, once; a copy that
 * does not install updates itself (the portable exe, the .deb) finding a newer
 * release is, once — with a way to the download. A check from the Help menu always
 * gets an answer, because somebody is waiting for one.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../../../src/shared/updates'

const getUpdateState = vi.fn()
const checkForUpdates = vi.fn()
const installUpdate = vi.fn()
const takeInstalledUpdate = vi.fn()
const openExternal = vi.fn()
let pushState: (state: UpdateState) => void = () => undefined

vi.mock('../../../src/renderer/src/lib/api', () => ({
  api: {
    getUpdateState: () => getUpdateState(),
    checkForUpdates: () => checkForUpdates(),
    installUpdate: () => installUpdate(),
    takeInstalledUpdate: () => takeInstalledUpdate(),
    openExternal: (url: string) => openExternal(url),
    onUpdateState: (handler: (state: UpdateState) => void) => {
      pushState = handler
      return () => undefined
    }
  }
}))

const { useUpdateStore } = await import('../../../src/renderer/src/stores/updates')
const { useToastStore } = await import('../../../src/renderer/src/stores/toasts')

const ready: UpdateState = { mode: 'self', status: 'ready', version: '0.2.0' }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getUpdateState.mockResolvedValue({ mode: 'self', status: 'idle' })
  installUpdate.mockResolvedValue(undefined)
  takeInstalledUpdate.mockResolvedValue(null)
  openExternal.mockResolvedValue(undefined)
})

describe('news of an update', () => {
  it('says once that an update is ready, and restarts into it from there', async () => {
    const updates = useUpdateStore()
    const toasts = useToastStore()
    await updates.load()

    pushState({ mode: 'self', status: 'downloading', version: '0.2.0', percent: 60 })
    expect(toasts.toasts).toEqual([])

    pushState(ready)
    pushState(ready)
    expect(toasts.toasts).toHaveLength(1)
    expect(toasts.toasts[0].action?.label).toBe('Restart')

    toasts.act(toasts.toasts[0].id)
    expect(installUpdate).toHaveBeenCalledTimes(1)
  })

  it('points a copy that does not update itself at the download, and never offers a restart', async () => {
    getUpdateState.mockResolvedValue({ mode: 'notify', status: 'available', version: '0.2.0' })
    const updates = useUpdateStore()
    const toasts = useToastStore()
    // A window opened while the news is out hears it too.
    await updates.load()

    expect(toasts.toasts).toHaveLength(1)
    expect(toasts.toasts[0].action?.label).toBe('Download')
    toasts.act(toasts.toasts[0].id)
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/NelushaUdaraka/tableview/releases/tag/v0.2.0'
    )
    expect(installUpdate).not.toHaveBeenCalled()
  })

  it('follows the state the main process sends', async () => {
    const updates = useUpdateStore()
    await updates.load()
    pushState({ mode: 'self', status: 'downloading', version: '0.2.0', percent: 60 })
    expect(updates.state).toEqual({
      mode: 'self',
      status: 'downloading',
      version: '0.2.0',
      percent: 60
    })
  })
})

describe('a check from the Help menu', () => {
  it('gets an answer even when there is nothing new', async () => {
    checkForUpdates.mockResolvedValue({
      mode: 'self',
      status: 'up-to-date',
      checkedAt: '2026-10-19T09:00:00.000Z'
    })
    const updates = useUpdateStore()
    const toasts = useToastStore()

    await updates.check({ report: true })
    expect(toasts.toasts.map((toast) => toast.kind)).toEqual(['success'])
  })

  it('says why it failed', async () => {
    checkForUpdates.mockResolvedValue({
      mode: 'self',
      status: 'error',
      error: 'Could not reach GitHub. Check the connection and try again.'
    })
    const updates = useUpdateStore()
    const toasts = useToastStore()

    await updates.check({ report: true })
    expect(toasts.toasts).toHaveLength(1)
    expect(toasts.toasts[0].kind).toBe('error')
    expect(toasts.toasts[0].detail).toBe('Could not reach GitHub. Check the connection and try again.')
  })

  it('brings back the news of an update already waiting', async () => {
    getUpdateState.mockResolvedValue(ready)
    checkForUpdates.mockResolvedValue(ready)
    const updates = useUpdateStore()
    const toasts = useToastStore()
    await updates.load()
    toasts.dismiss(toasts.toasts[0].id)

    await updates.check({ report: true })
    expect(toasts.toasts).toHaveLength(1)
    expect(toasts.toasts[0].action?.label).toBe('Restart')
  })

  it('says so when the check cannot be made at all, rather than throwing', async () => {
    checkForUpdates.mockRejectedValue(new Error('No handler registered for updates:check'))
    const updates = useUpdateStore()
    const toasts = useToastStore()

    expect(await updates.check()).toEqual({ mode: 'unsupported', status: 'idle' })
    expect(toasts.toasts.map((toast) => toast.kind)).toEqual(['error'])
  })

  it('leaves the answer to the Settings dialog when that is where the check came from', async () => {
    checkForUpdates.mockResolvedValue({
      mode: 'self',
      status: 'up-to-date',
      checkedAt: '2026-10-19T09:00:00.000Z'
    })
    const updates = useUpdateStore()
    const toasts = useToastStore()

    expect(await updates.check()).toMatchObject({ status: 'up-to-date' })
    expect(updates.state.status).toBe('up-to-date')
    expect(toasts.toasts).toEqual([])
  })
})

describe('restarting into an update', () => {
  it('says when the update went in, with the way to what it changed', async () => {
    takeInstalledUpdate.mockResolvedValue('0.2.0')
    const updates = useUpdateStore()
    const toasts = useToastStore()
    await updates.load()

    expect(toasts.toasts).toHaveLength(1)
    expect(toasts.toasts[0]).toMatchObject({ kind: 'success', message: 'TableView updated to 0.2.0' })
    toasts.act(toasts.toasts[0].id)
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/NelushaUdaraka/tableview/releases/tag/v0.2.0'
    )
  })

  it('says nothing after a run of the same version', async () => {
    const updates = useUpdateStore()
    const toasts = useToastStore()
    await updates.load()
    expect(toasts.toasts).toEqual([])
  })

  it('says so when the restart fails, since the app was expected to close', async () => {
    const updates = useUpdateStore()
    const toasts = useToastStore()
    await updates.load()
    pushState(ready)
    toasts.dismiss(toasts.toasts[0].id)

    pushState({ mode: 'self', status: 'installing', version: '0.2.0' })
    expect(toasts.toasts).toEqual([])
    pushState({ mode: 'self', status: 'error', error: 'The update could not be installed.' })
    expect(toasts.toasts.map((toast) => [toast.kind, toast.message])).toEqual([
      ['error', 'Could not install the update']
    ])
  })
})
