/**
 * What this window knows about updating, and what it tells the reader.
 *
 * The main process does all the deciding and sends every change to every
 * window. What a window adds is judgement about interruptions: an update ready
 * to install is worth a toast, and so is a newer release the portable exe has
 * found — once each, however often that state comes round again. A check
 * somebody asked for from the Help menu always gets an answer, since they are
 * waiting for one; a check from the Settings dialog is answered by the dialog.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { releasePage, type UpdateState } from '@shared/updates'
import { api } from '../lib/api'
import { useToastStore } from './toasts'

export const useUpdateStore = defineStore('updates', () => {
  const toasts = useToastStore()
  const state = ref<UpdateState>({ mode: 'unsupported', status: 'idle' })
  /** The release the reader has been told about, so it is not news twice. */
  let announced: string | null = null
  /** Subscribed for the life of the window, and only once. */
  let listening = false

  /** An update waiting on the reader: to be installed, or downloaded by hand. */
  function isNews(next: UpdateState): boolean {
    return next.status === 'ready' || (next.status === 'available' && next.mode === 'portable')
  }

  function announce(next: UpdateState): void {
    const version = next.version
    if (!version) return
    announced = version
    if (next.status === 'ready') {
      toasts.push(
        'info',
        `TableView ${version} is ready to install`,
        'Restart now, or it installs the next time you quit.',
        { action: { label: 'Restart', run: install } }
      )
    } else {
      toasts.push(
        'info',
        `TableView ${version} is available`,
        'The portable app cannot update itself. Download the new one from its release page.',
        { action: { label: 'Download', run: () => download(version) } }
      )
    }
  }

  function receive(next: UpdateState): void {
    state.value = next
    if (isNews(next) && next.version !== announced) announce(next)
  }

  /** The answer to a check from the Help menu, when it is not news already. */
  function report(next: UpdateState): void {
    if (next.mode === 'unsupported') {
      toasts.info(
        'This copy of TableView does not update itself',
        'Updates come to the Windows installer and the portable app.'
      )
      return
    }
    switch (next.status) {
      case 'up-to-date':
        toasts.success('TableView is up to date')
        break
      case 'available':
      case 'downloading':
        toasts.info(`Downloading TableView ${next.version}`, 'It says so here when it is ready to install.')
        break
      case 'error':
        toasts.error('Could not check for updates', next.error)
        break
    }
  }

  async function load(): Promise<void> {
    if (!listening) {
      api.onUpdateState(receive)
      listening = true
    }
    receive(await api.getUpdateState())
  }

  /**
   * Looks for a newer release now. With `report`, the reader is told what was
   * found, even an update they have already heard about: they asked.
   */
  async function check(options: { report?: boolean } = {}): Promise<UpdateState> {
    let next: UpdateState
    try {
      next = await api.checkForUpdates()
    } catch (error) {
      // A failed check comes back as a state; this is the check never made.
      toasts.fromError('Could not check for updates', error)
      return state.value
    }
    if (options.report && isNews(next)) {
      state.value = next
      announce(next)
      return next
    }
    receive(next)
    if (options.report) report(next)
    return next
  }

  /** Restarts into the downloaded update; unsaved work is asked about first. */
  function install(): void {
    api.installUpdate().catch((error) => toasts.fromError('Could not restart into the update', error))
  }

  /** Opens the page a newer portable release is downloaded from. */
  function download(version = state.value.version): void {
    if (!version) return
    api
      .openExternal(releasePage(version))
      .catch((error) => toasts.fromError('Could not open the release page', error))
  }

  return { state, load, check, install, download }
})
