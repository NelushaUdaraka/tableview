/**
 * Asking the user about an SSH server's key.
 *
 * A native dialog rather than one drawn by the window: the answer decides
 * whether to trust a server with a password, and the main process should not
 * take it from a page it cannot vouch for.
 */
import { BrowserWindow, dialog } from 'electron'
import type { HostKeyQuestion } from './tunnel/hostKeys'

export async function askAboutHostKey(
  question: HostKeyQuestion,
  parent: BrowserWindow | null
): Promise<boolean> {
  const where = `${question.host}:${question.port}`
  const key = `${question.key.type}\n${question.key.fingerprint}`

  const options: Electron.MessageBoxOptions = question.previous
    ? {
        type: 'warning',
        title: 'SSH server key changed',
        message: `The SSH server at ${where} has a different key`,
        detail:
          `The key it had before:\n${question.previous.type}\n${question.previous.fingerprint}\n\n` +
          `The key it shows now:\n${key}\n\n` +
          'A server that was rebuilt or given a new key shows one; so does someone standing in for ' +
          'it to read your password and your data. Ask whoever runs the server before trusting the new key.',
        buttons: ['Cancel', 'Trust the new key'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
    : {
        type: 'question',
        title: 'Trust this SSH server?',
        message: `First connection to the SSH server at ${where}`,
        detail:
          `TableView has not connected to this server before, so it cannot yet tell it from one ` +
          `pretending to be it. Its key:\n${key}\n\n` +
          'If you can, check this against the fingerprint whoever runs the server gives you. ' +
          'Once trusted, it is asked about again only if the key changes.',
        buttons: ['Cancel', 'Trust and connect'],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      }

  const live = parent && !parent.isDestroyed() ? parent : null
  const { response } = live
    ? await dialog.showMessageBox(live, options)
    : await dialog.showMessageBox(options)
  return response === 1
}
