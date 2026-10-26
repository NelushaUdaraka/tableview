/**
 * Runs a query tab's SQL — all of it, or the part given — and puts the answer
 * on the tab.
 *
 * Kept out of the view because a tab does not have to be on screen to be
 * run: closing a routine's tab with its changes unsaved offers to save them,
 * which is running its script, from wherever that tab happens to be — a ✕ on
 * a tab in the background, or Close all.
 */
import { markRaw } from 'vue'
import { api } from './api'
import { scriptWrites } from './confirmWrites'
import { runNotice, shouldNotify, type RunOutcome } from './runNotice'
import { compilesOnly } from '@shared/showplan'
import type { PlanKind } from '@shared/types'
import { useBusyStore } from '../stores/busy'
import { useConfirmWritesStore } from '../stores/confirmWrites'
import { useConnectionStore } from '../stores/connections'
import { useCredentialsStore } from '../stores/credentials'
import { useLibraryStore } from '../stores/library'
import { useSettingsStore } from '../stores/settings'
import { useTabStore, type QueryTab } from '../stores/tabs'
import { useToastStore } from '../stores/toasts'

/**
 * Resolves true when the whole script ran without an error — which, for a
 * routine's tab, is what saves the routine.
 *
 * `plan` asks for the execution plan as well: `estimated` compiles the script
 * without running it — so it saves nothing — and `actual` runs it and brings
 * back the plan each statement used.
 */
export async function runQueryTab(
  tabId: string,
  text?: string,
  options: { plan?: PlanKind } = {}
): Promise<boolean> {
  const tabs = useTabStore()
  const toasts = useToastStore()
  const busy = useBusyStore()
  const settings = useSettingsStore()
  const library = useLibraryStore()
  const connections = useConnectionStore()
  const credentials = useCredentialsStore()

  const tab = tabs.tabs.find(
    (entry): entry is QueryTab => entry.id === tabId && entry.kind === 'query'
  )
  if (!tab) return false
  const body = (text ?? tab.sql).trim()
  if (!body) return false
  if (tab.running) {
    toasts.info('A query is already running in this tab')
    return false
  }

  /**
   * A session that ran out mid-query is worth a paste box, not a toast — the
   * query itself was fine and can be rerun once the credentials are fresh.
   */
  const offerCredentialFix = (error: unknown): boolean => {
    const connection = connections.saved.find((entry) => entry.id === tab.connectionId)
    return credentials.offerRefresh(connection, error, async () => {
      await runQueryTab(tabId, text)
    })
  }

  // A connection that confirms its writes shows what this one would change
  // first, and sends nothing until it is told to. The main process checks
  // again, and refuses a write that does not come marked as confirmed.
  let confirmedWrites = false
  const confirmWrites = useConfirmWritesStore()
  // An estimated plan runs none of the script, so there is nothing to confirm
  // — unless the script turns compiling-only off itself.
  const runsNothing = options.plan === 'estimated' && compilesOnly(body)
  if (confirmWrites.asking() && !runsNothing) {
    const database =
      tab.session?.database ??
      tab.routine?.database ??
      connections.activeStatus?.currentDatabase ??
      ''
    const writes = scriptWrites(body, database)
    if (writes.length > 0) {
      const proceed = await confirmWrites.askAbout(writes, {
        title: writes.length === 1 ? 'Run a statement that writes?' : 'Run statements that write?',
        action: 'Run anyway'
      })
      if (!proceed) return false
      confirmedWrites = true
    }
  }

  const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // A loss said after the last run has been read; this run says its own.
  tabs.update<QueryTab>(tabId, { running: true, executionId, sessionLost: undefined })
  // The bar under the title bar carries the wait for the whole window, so a
  // query running in a pane that is not on screen is still visible as work.
  busy.begin()

  // The script as it was sent, whatever is typed while it runs — and whether
  // it was all of it, which a selection covering the whole tab also is.
  const script = tab.sql
  const whole = body === script.trim()
  const startedAt = Date.now()

  /**
   * A run that took a while, in a window that is behind another, says it has
   * ended on the desktop. With no document to ask — the unit tests — the
   * window counts as watched.
   */
  const notifyIfAway = (outcome: Omit<RunOutcome, 'elapsedMs'>): void => {
    const run = { ...outcome, elapsedMs: Date.now() - startedAt }
    const focused = globalThis.document?.hasFocus?.() ?? true
    if (!shouldNotify(run, focused, settings.settings)) return
    const title = tabs.tabs.find((entry) => entry.id === tabId)?.title ?? tab.title
    void api.notifyQueryFinished({ ...runNotice(title, run), tabId }).catch(() => undefined)
  }

  try {
    const result = await api.runQuery({
      connectionId: tab.connectionId,
      sql: body,
      maxRows: settings.settings.maxResultRows,
      executionId,
      // The tab's own session, kept from one run to the next; a routine's
      // stays in the database the routine lives in.
      sessionId: tab.id,
      pinnedDatabase: tab.routine?.database,
      confirmedWrites,
      ...(options.plan ? { plan: options.plan } : {})
    })
    // markRaw keeps the (potentially huge) result set out of the reactivity
    // graph; it is only ever replaced, never mutated field by field.
    tabs.update<QueryTab>(tabId, {
      result: markRaw(result),
      running: false,
      executionId: null,
      session: result.session,
      sessionLost: result.sessionLost?.had
    })

    const failed = result.statements.find((statement) => statement.error)
    // A plan that was only estimated ran nothing, so it saved no routine.
    const ranInFull =
      whole && !failed && !result.cancelled && result.statements.length > 0 && !runsNothing
    // Running the whole tab without an error is what saves a routine — its
    // `CREATE OR ALTER` replaces the stored definition — so from then on the
    // changes worth marking are the ones made since. A selection, a single
    // statement, a failure or a cancel leaves it where it was: none of those
    // can be taken to have written the routine.
    //
    // The script that ran, not the definition read back: SQL Server does not
    // keep what it was sent — `CREATE OR ALTER` comes back as `CREATE` with
    // the `OR ALTER` blanked out — so a re-read would mark a change on the
    // first line of every routine the moment it was saved.
    if (ranInFull && tab.routine) tabs.storeRoutine(tab.connectionId, tab.routine, script)

    if (failed?.error && !offerCredentialFix(failed.error)) {
      toasts.error('Query failed', failed.error.message)
    }
    notifyIfAway({ result })
    void library.loadHistory()
    return ranInFull
  } catch (error) {
    tabs.update<QueryTab>(tabId, { running: false, executionId: null })
    notifyIfAway({ error: error instanceof Error ? error.message : String(error) })
    if (!offerCredentialFix(error)) toasts.fromError('Query failed', error)
    return false
  } finally {
    busy.end()
  }
}
