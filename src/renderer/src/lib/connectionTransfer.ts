/**
 * Moving the connection list in and out of a file.
 *
 * Lives outside any one view because File → Import/Export Connections has to
 * work from wherever the window is: the connection screen offers them on its
 * ⋮, and the workspace has only the menu — before, only the screen listened,
 * so from a connected window the menu items did nothing at all.
 */
import { useConnectionStore } from '../stores/connections'
import { useToastStore } from '../stores/toasts'

/**
 * Writes the connection list to a file.
 *
 * No secrets travel, so the toast says which of them will have to be typed
 * again at the other end rather than leaving that to be found out on the
 * first failed connect.
 */
export async function exportConnections(): Promise<void> {
  const connections = useConnectionStore()
  const toasts = useToastStore()
  try {
    const result = await connections.exportAll()
    // Null is the save dialog dismissed; nothing happened and nothing is said.
    if (!result) return
    const needing = connections.saved.filter(
      (entry) =>
        entry.hasSavedPassword ||
        entry.hasSavedSshPassword ||
        entry.hasSavedSshPassphrase ||
        entry.hasSavedAwsCredentials
    ).length
    const counted = `${result.connections} ${result.connections === 1 ? 'connection' : 'connections'}`
    const grouped = result.groups > 0 ? `, ${result.groups} groups` : ''
    toasts.success(
      `Exported ${counted}${grouped}`,
      needing > 0
        ? `No passwords are in the file — ${needing} will need theirs entered again.`
        : 'No passwords are in the file.'
    )
  } catch (error) {
    toasts.fromError('Could not export the connections', error)
  }
}

export async function importConnections(): Promise<void> {
  const connections = useConnectionStore()
  const toasts = useToastStore()
  try {
    const summary = await connections.importFile()
    if (!summary) return
    if (summary.added.length === 0 && summary.skipped.length > 0) {
      toasts.info('Nothing new to import', `Already here: ${summary.skipped.join(', ')}`)
      return
    }
    const detail = [
      summary.skipped.length > 0 ? `${summary.skipped.length} already here` : '',
      summary.needSecrets.length > 0
        ? `${summary.needSecrets.length} need a password entering`
        : ''
    ].filter(Boolean)
    toasts.success(
      `Imported ${summary.added.length} ${summary.added.length === 1 ? 'connection' : 'connections'}`,
      detail.join(' · ') || undefined
    )
  } catch (error) {
    toasts.fromError('Could not import the connections', error)
  }
}
