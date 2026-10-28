<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ConnectionConfig, ConnectionSortKey, SavedConnection } from '@shared/types'
import { parseHex, textOn } from '@shared/accent'
import AppIcon from '../components/AppIcon.vue'
import BaseModal from '../components/BaseModal.vue'
import BrandMark from '../components/BrandMark.vue'
import ConnectionForm from '../components/ConnectionForm.vue'
import ContextMenu, { type MenuEntry } from '../components/ContextMenu.vue'
import { useConfirmStore } from '../stores/confirm'
import { useConnectionStore } from '../stores/connections'
import { useCredentialsStore } from '../stores/credentials'
import { useReadOnlyStore } from '../stores/readOnly'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toasts'
import { onMenuAction } from '../lib/menuBus'
import { exportConnections, importConnections } from '../lib/connectionTransfer'
import { CONNECTION_SORT_OPTIONS, describeSort } from '../lib/sortConnections'
import { groupConnections, hasGroups } from '../lib/connectionGroups'
import { api } from '../lib/api'
import {
  isUntrustedCertificateError,
  trustCertificateQuestion,
  withTrustedCertificate
} from '../lib/certificates'

const connections = useConnectionStore()
const confirmQuestion = useConfirmStore()
const credentials = useCredentialsStore()
const readOnly = useReadOnlyStore()
const settings = useSettingsStore()
const toasts = useToastStore()

const connectionForm = ref<InstanceType<typeof ConnectionForm> | null>(null)
const editing = ref<SavedConnection | null>(null)
/** The connection the open form is a copy of, when it is one. */
const copiedFrom = ref<string | null>(null)
const showForm = ref(false)
/** Whether the form opens with the TablePlus steps showing rather than folded. */
const tablePlusOpen = ref(false)
const testing = ref(false)
const search = ref('')
/**
 * The one menu this screen opens, wherever it was opened from.
 *
 * A row's ⋮, a right-click and the header's ⋮ all raise the same component
 * with different items, so what it holds travels with where it was opened —
 * and `key` is what makes it remeasure its position when that moves.
 */
interface ScreenMenu {
  x: number
  y: number
  key: string
  items: MenuEntry[]
  connection?: SavedConnection
}
const menu = ref<ScreenMenu | null>(null)
const passwordPrompt = ref<{ connection: SavedConnection; value: string } | null>(null)

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase()
  if (!needle) return connections.sorted
  return connections.sorted.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) ||
      entry.host.toLowerCase().includes(needle) ||
      (entry.database ?? '').toLowerCase().includes(needle)
  )
})

/**
 * The filtered list under its headings.
 *
 * A search reaches into folded groups: the connection someone is typing the
 * name of is exactly the one a closed heading would be hiding, so while there
 * is a search the folds are ignored rather than searched around.
 */
const searching = computed(() => search.value.trim().length > 0)
const groupedRows = computed(() => groupConnections(filtered.value))
const showHeadings = computed(() => hasGroups(connections.saved))

function folded(group: string): boolean {
  return !searching.value && connections.isCollapsed(group)
}

/** How the active order reads, for the control that flips it. */
const sortDescription = computed(() =>
  describeSort(connections.sortKey, connections.sortDirection)
)

/**
 * Re-sorts the list, and remembers the choice.
 *
 * The order is a setting, so changing it is a write that can fail; the list
 * follows the setting, which means a failed write leaves the list as it was
 * and the toast is the only way the reader would know.
 */
async function chooseSort(key: ConnectionSortKey): Promise<void> {
  try {
    await connections.setSortKey(key)
  } catch (error) {
    toasts.fromError('Could not change the sort order', error)
  }
}

async function flipSortDirection(): Promise<void> {
  try {
    await connections.toggleSortDirection()
  } catch (error) {
    toasts.fromError('Could not change the sort order', error)
  }
}

let unsubscribeMenu: (() => void) | null = null

onMounted(() => {
  void connections.load()
  // File → New Connection has nowhere else to land while this screen is up.
  unsubscribeMenu = onMenuAction((action) => {
    if (action === 'connection:new') startNew()
    else if (action === 'connections:import') void importConnections()
    else if (action === 'connections:import-tableplus') startTablePlusImport()
    else if (action === 'connections:export') void exportConnections()
  })
})

onBeforeUnmount(() => unsubscribeMenu?.())

/** What the form's dialog is for, said above its title. */
const formKicker = computed(() => {
  if (!editing.value) return 'New connection'
  return copiedFrom.value ? `Copy of ${copiedFrom.value}` : 'Edit connection'
})

function startNew(): void {
  editing.value = null
  copiedFrom.value = null
  tablePlusOpen.value = false
  showForm.value = true
}

/**
 * A new connection with the steps for getting one out of TablePlus showing.
 *
 * Its own function rather than a flag on `startNew`, which is bound straight
 * to a button's click and would take the click event for the flag.
 */
function startTablePlusImport(): void {
  startNew()
  tablePlusOpen.value = true
}

function startEdit(connection: SavedConnection): void {
  editing.value = connection
  copiedFrom.value = null
  showForm.value = true
}

async function save(input: Partial<ConnectionConfig> & { name: string }): Promise<void> {
  try {
    await connections.save(input)
    showForm.value = false
    toasts.success('Connection saved')
  } catch (error) {
    toasts.fromError('Could not save the connection', error)
  }
}

async function test(input: Partial<ConnectionConfig>): Promise<void> {
  testing.value = true
  try {
    const status = await api.testConnection(input)
    if (status.state === 'connected') {
      toasts.success(
        'Connection succeeded',
        `${status.serverEdition ?? ''} ${status.serverVersion ?? ''}`.trim()
      )
    } else if (
      !credentials.offerRefresh(editing.value, status.error, () => test(input)) &&
      !(await offerTrustOnTest(input, status.error))
    ) {
      toasts.error('Connection failed', status.error?.message)
    }
  } catch (error) {
    if (
      !credentials.offerRefresh(editing.value, error, () => test(input)) &&
      !(await offerTrustOnTest(input, error))
    ) {
      toasts.fromError('Connection failed', error)
    }
  } finally {
    testing.value = false
  }
}

/**
 * After a test turned down over the server's certificate, offers to trust it:
 * yes ticks the form's box and tests again. Nothing is saved until Save, as
 * with anything else in the form. True when the failure was that.
 */
async function offerTrustOnTest(input: Partial<ConnectionConfig>, error: unknown): Promise<boolean> {
  if (!isUntrustedCertificateError(error)) return false
  const target = {
    name: input.name ?? editing.value?.name ?? 'this connection',
    host: input.host ?? editing.value?.host ?? '',
    port: input.port ?? editing.value?.port ?? 1433
  }
  if (await confirmQuestion.ask(trustCertificateQuestion(target, 'form'))) {
    connectionForm.value?.trustServerCertificate()
    await test(withTrustedCertificate(input))
  }
  return true
}

/**
 * After a connect turned down over the server's certificate, offers to trust
 * it: yes saves the setting with the connection and connects again. True when
 * the failure was that.
 */
async function offerTrustOnConnect(
  connection: SavedConnection,
  error: unknown,
  password?: string
): Promise<boolean> {
  if (!isUntrustedCertificateError(error)) return false
  if (!(await confirmQuestion.ask(trustCertificateQuestion(connection, 'saved')))) return true
  try {
    // Only the options are sent; everything else saved with it stays as it is.
    const trusted = await connections.save(
      withTrustedCertificate({ id: connection.id, name: connection.name, options: connection.options })
    )
    await open(trusted, password)
  } catch (error) {
    toasts.fromError('Could not save the connection', error)
  }
  return true
}

/** Connects, prompting for a password when none is stored. */
async function open(connection: SavedConnection, password?: string): Promise<void> {
  const needsPassword =
    connection.authType !== 'windows' && !connection.hasSavedPassword && password === undefined
  if (needsPassword) {
    passwordPrompt.value = { connection, value: '' }
    return
  }

  const status = await connections.connect(connection.id, password)
  if (status.state === 'error') {
    // Expired credentials and an untrusted certificate are the failures with
    // a fix worth offering in place.
    const offered =
      credentials.offerRefresh(connection, status.error, () => open(connection, password)) ||
      (await offerTrustOnConnect(connection, status.error, password))
    if (!offered) toasts.error(`Could not connect to ${connection.name}`, status.error?.message)
  } else {
    passwordPrompt.value = null
  }
}

async function remove(connection: SavedConnection): Promise<void> {
  const proceed = await confirmQuestion.ask({
    kicker: 'Connection',
    title: `Delete “${connection.name}”?`,
    message: 'It goes from the list, with anything saved for it. This cannot be undone.',
    action: 'Delete'
  })
  if (!proceed) return
  await connections.remove(connection.id)
  toasts.info('Connection deleted')
}

/**
 * Copies a connection and opens the copy in the form.
 *
 * Duplicating is how one connection becomes a variant of another — the same
 * host with a different database, the same bastion with a different login —
 * so the copy is only ever a step on the way to editing it. Leaving it in the
 * list would mean hunting it down and clicking Edit; the form opens on it
 * instead, with the password and the AWS credentials already carried over.
 */
async function duplicate(connection: SavedConnection): Promise<void> {
  try {
    const copy = await connections.duplicate(connection.id)
    if (!copy) {
      toasts.error('Could not duplicate the connection', 'It is no longer saved.')
      return
    }
    editing.value = copy
    copiedFrom.value = connection.name
    showForm.value = true
    toasts.success(`Copied “${connection.name}”`, `Editing “${copy.name}”`)
  } catch (error) {
    toasts.fromError('Could not duplicate the connection', error)
  }
}

/**
 * Saves the form's edits as a second connection, leaving the open one alone.
 *
 * The copy is made in the main process first so the secrets come with it: the
 * form only holds what has been typed into it, and a blank password means
 * "keep the stored one", which is only true of a record that already has one.
 * The edits then land on the copy exactly as Save would have landed them on
 * the original.
 */
async function saveAsCopy(input: Partial<ConnectionConfig> & { name: string }): Promise<void> {
  const source = editing.value
  if (!source) return

  try {
    const copy = await connections.duplicate(source.id)
    if (!copy) {
      toasts.error('Could not duplicate the connection', 'It is no longer saved.')
      return
    }

    // A name left untouched would give the copy the original's, and two
    // identical rows in the list; the generated one is what tells them apart.
    const renamed = input.name.trim() === source.name.trim() ? copy.name : input.name.trim()
    try {
      editing.value = await connections.save({ ...input, id: copy.id, name: renamed })
    } catch (error) {
      // Don't leave a half-made copy behind when it was the edits that failed —
      // and report why the save failed, not why the tidy-up did.
      await connections.remove(copy.id).catch(() => undefined)
      throw error
    }
    copiedFrom.value = source.name
    toasts.success('Saved as a copy', `“${editing.value.name}” — “${source.name}” is unchanged`)
  } catch (error) {
    toasts.fromError('Could not duplicate the connection', error)
  }
}

/**
 * Opens a row's menu under its ⋮, or closes it when that row's is already open.
 *
 * The button swallows its own mousedown so the menu's click-away does not fire
 * first: without that, every click on ⋮ would close the menu and reopen it, and
 * the one thing a menu button has to do is close the menu it opened.
 */
function toggleRowMenu(connection: SavedConnection, event: MouseEvent): void {
  if (menu.value?.connection?.id === connection.id) {
    menu.value = null
    return
  }
  openUnder(event, rowMenuItems(connection), connection)
}

/** The same menu, raised where the pointer is rather than under a button. */
function openContextMenu(connection: SavedConnection, event: MouseEvent): void {
  menu.value = {
    x: event.clientX,
    y: event.clientY,
    key: `${connection.id}:${event.clientX}:${event.clientY}`,
    items: rowMenuItems(connection),
    connection
  }
}

/** The header's ⋮ — what the whole list can do, rather than one row. */
function toggleScreenMenu(event: MouseEvent): void {
  if (menu.value && !menu.value.connection) {
    menu.value = null
    return
  }
  openUnder(event, transferItems)
}

/**
 * Hangs a menu off the button that raised it.
 *
 * Anchored to the button rather than the pointer; the menu nudges itself back
 * on-screen from there, which near the right edge means tucking under it.
 */
function openUnder(event: MouseEvent, items: MenuEntry[], connection?: SavedConnection): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  menu.value = {
    x: rect.right,
    y: rect.bottom + 4,
    key: `${connection?.id ?? 'screen'}:${rect.right}:${rect.bottom}`,
    items,
    connection
  }
}

/** Where a connection can be moved to, which is every group but its own. */
function moveTargets(connection: SavedConnection): MenuEntry[] {
  const current = connection.group?.trim() ?? ''
  const targets: MenuEntry[] = connections.groups
    .filter((name) => name !== current)
    .map((name) => ({ label: name, action: `group:${name}` }))
  // Somewhere to put it back, but only when it is in a group to begin with.
  if (current) targets.unshift({ label: 'No group', action: 'group:' })
  return targets
}

function rowMenuItems(connection: SavedConnection): MenuEntry[] {
  const targets = moveTargets(connection)
  return [
    { label: 'Connect', action: 'connect' },
    { label: 'Edit…', action: 'edit' },
    { label: 'Duplicate…', action: 'duplicate' },
    // Switched here rather than in the form: turning it on is one click, and
    // turning it off asks first, as every read-only toggle does.
    {
      label: connection.readOnly ? 'Turn off read-only…' : 'Turn on read-only',
      action: 'read-only'
    },
    // Beside it, and switched the same way: off asks first when that leaves
    // the connection writing without asking.
    {
      label: connection.confirmWrites
        ? connection.readOnly
          ? 'Stop confirming writes'
          : 'Stop confirming writes…'
        : 'Confirm writes',
      action: 'confirm-writes'
    },
    // No groups yet means nothing to move between; the form makes the first.
    ...(targets.length > 0 ? [{ label: 'Move to', items: targets }] : []),
    { separator: true, label: '' },
    { label: 'Delete', action: 'delete', danger: true }
  ]
}

const transferItems: MenuEntry[] = [
  { label: 'Import connections…', action: 'import' },
  { label: 'Import from TablePlus…', action: 'import-tableplus' },
  { label: 'Export connections…', action: 'export' }
]

async function onMenuSelect(action: string): Promise<void> {
  if (action === 'import') return importConnections()
  if (action === 'import-tableplus') return startTablePlusImport()
  if (action === 'export') return exportConnections()

  const connection = menu.value?.connection
  if (!connection) return
  if (action === 'connect') await open(connection)
  else if (action === 'edit') startEdit(connection)
  else if (action === 'duplicate') await duplicate(connection)
  else if (action === 'read-only') await readOnly.setReadOnly(connection, !connection.readOnly)
  else if (action === 'confirm-writes') {
    await readOnly.setConfirmWrites(connection, !connection.confirmWrites)
  }
  else if (action === 'delete') await remove(connection)
  else if (action.startsWith('group:')) await moveToGroup(connection, action.slice(6))
}

async function moveToGroup(connection: SavedConnection, group: string): Promise<void> {
  try {
    await connections.setGroup(connection, group)
    toasts.success(
      group ? `Moved “${connection.name}” to ${group}` : `Took “${connection.name}” out of its group`
    )
  } catch (error) {
    toasts.fromError('Could not move the connection', error)
  }
}

/** The ink that reads on a connection's own colour, for the icon on its tile. */
function inkOn(colour?: string): string | undefined {
  const rgb = parseHex(colour)
  return rgb ? textOn(rgb) : undefined
}

function endpoint(connection: SavedConnection): string {
  return `${connection.host}:${connection.port}`
}

/** How the connection gets there — the detail people scan for. */
function route(connection: SavedConnection): string {
  const ssm = connection.ssm
  if (ssm?.enabled) {
    // A bastion found by name has no ID until it opens, so the name is what
    // there is to show — and the more useful of the two to recognise anyway.
    const bastion =
      ssm.target === 'name' ? ssm.instanceName?.trim() : ssm.instanceId?.trim()
    return `via SSM ${bastion || '(no instance)'}`
  }
  if (connection.ssh?.enabled) return `via ${connection.ssh.host}`
  return 'direct'
}

function transportBadge(connection: SavedConnection): string | null {
  if (connection.ssm?.enabled) return 'SSM'
  if (connection.ssh?.enabled) return 'SSH'
  return null
}

/** The day a connection was made — the short form, since it sits under the row. */
function createdOn(iso?: string): string | null {
  if (!iso) return null
  const time = Date.parse(iso)
  return Number.isNaN(time) ? null : new Date(time).toLocaleDateString()
}

function relativeTime(iso?: string): string {
  if (!iso) return 'never opened'
  const delta = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(delta / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString()
}
</script>

<template>
  <div class="screen">
    <header class="screen__head">
      <div class="brand">
        <BrandMark class="brand__mark" :size="44" />
        <div class="brand__text">
          <h1 class="brand__title">TableView</h1>
          <p class="brand__sub">
            SQL Server client · {{ connections.saved.length }} saved
            {{ connections.saved.length === 1 ? 'connection' : 'connections' }}
          </p>
        </div>
      </div>
      <div class="screen__actions">
        <button
          class="screen__theme"
          :title="settings.resolvedTheme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'"
          aria-label="Toggle theme"
          @click="settings.toggleTheme()"
        >
          <AppIcon :name="settings.resolvedTheme === 'dark' ? 'sun' : 'moon'" :size="16" />
        </button>
        <button
          class="screen__theme screen__more"
          title="Import or export connections"
          aria-label="Import or export connections"
          aria-haspopup="menu"
          :aria-expanded="Boolean(menu && !menu.connection)"
          @mousedown.stop
          @click.stop="toggleScreenMenu($event)"
        >
          <AppIcon name="more" :size="16" />
        </button>
        <button class="btn btn--lg btn--primary" @click="startNew">
          <AppIcon name="plus" :size="16" />
          New connection
        </button>
      </div>
    </header>

    <div class="screen__body">
      <div class="screen__tools">
        <div class="screen__search">
          <AppIcon class="screen__search-glyph" name="search" :size="15" />
          <input
            v-model="search"
            class="screen__search-input"
            placeholder="Search connections…"
            spellcheck="false"
          />
        </div>

        <div class="screen__sort">
          <label class="caps screen__sort-label" for="connection-sort">Sort by</label>
          <select
            id="connection-sort"
            class="select screen__sort-select"
            :value="connections.sortKey"
            @change="chooseSort(($event.target as HTMLSelectElement).value as ConnectionSortKey)"
          >
            <option v-for="option in CONNECTION_SORT_OPTIONS" :key="option.key" :value="option.key">
              {{ option.label }}
            </option>
          </select>
          <!-- The caret says which way the list reads, and flips it. -->
          <button
            class="btn screen__sort-flip"
            :title="sortDescription"
            :aria-label="`Sort order: ${sortDescription}. Reverse it.`"
            @click="flipSortDirection()"
          >
            {{ connections.sortDirection === 'asc' ? '↑' : '↓' }}
          </button>
        </div>
      </div>

      <div v-if="filtered.length === 0" class="empty-state">
        <div class="empty-state__icon">
          <AppIcon :name="connections.saved.length === 0 ? 'database' : 'search'" :size="20" />
        </div>
        <div class="empty-state__title">
          {{ connections.saved.length === 0 ? 'No saved connections yet' : 'No matches' }}
        </div>
        <p v-if="connections.saved.length === 0">
          Create one to get started — host, login, and an optional SSH tunnel.
        </p>
        <p v-else>Nothing matches “{{ search.trim() }}” by name, host or database.</p>
        <button v-if="connections.saved.length === 0" class="btn btn--primary" @click="startNew">
          <AppIcon name="plus" :size="14" />
          New connection
        </button>
      </div>

      <div v-else class="table">
        <div class="table__head">
          <div></div>
          <div class="table__cell table__cell--wide">Name</div>
          <div class="table__cell table__cell--wide">Endpoint</div>
          <div class="table__cell">Transport</div>
          <div class="table__cell">Auth</div>
          <div class="table__cell table__cell--right">Last opened</div>
          <div></div>
        </div>

        <div class="table__body">
          <template v-for="group in groupedRows" :key="group.name || '(ungrouped)'">
            <!-- Only once a group exists: one heading reading "Ungrouped" over
                 a list that has never been filed is a heading about nothing. -->
            <button
              v-if="showHeadings"
              type="button"
              class="group"
              :aria-expanded="!folded(group.name)"
              @click="connections.toggleGroup(group.name)"
            >
              <AppIcon
                class="group__caret"
                :class="{ 'group__caret--open': !folded(group.name) }"
                name="chevron-right"
                :size="12"
              />
              <span class="group__name" :class="{ 'group__name--none': !group.name }">
                {{ group.label }}
              </span>
              <span class="group__count mono">{{ group.connections.length }}</span>
            </button>

            <template v-if="!folded(group.name)">
          <div
            v-for="connection in group.connections"
            :key="connection.id"
            class="row"
            :class="{ 'row--busy': connections.connectingId === connection.id }"
            @dblclick="open(connection)"
            @contextmenu.prevent="openContextMenu(connection, $event)"
          >
            <!-- The connection's colour, on a tile, so a red one still says
                 "production" from across the room. -->
            <span
              class="row__avatar"
              :class="{ 'row__avatar--plain': !connection.color }"
              :style="connection.color ? { background: connection.color, color: inkOn(connection.color) } : {}"
            >
              <AppIcon name="database" :size="16" />
            </span>

            <div class="row__cell row__cell--wide row__identity">
              <div class="row__title">
                <div class="row__name truncate">{{ connection.name }}</div>
                <!-- Said before connecting, so nobody opens production expecting
                     to fix a row in it, or opens it unprotected by mistake. -->
                <span
                  v-if="connection.readOnly"
                  class="badge row__readonly"
                  title="Read-only: edits and statements that would change the database are refused"
                >
                  <AppIcon name="lock" :size="11" />
                  <span class="row__readonly-label">Read-only</span>
                </span>
                <span
                  v-else-if="connection.confirmWrites"
                  class="badge row__confirms"
                  title="Confirm writes: anything that would change the database is shown to you first, and runs only once you say so"
                >
                  <AppIcon name="shield-check" :size="11" />
                  <span class="row__readonly-label">Confirm writes</span>
                </span>
              </div>
              <div class="row__sub truncate">{{ connection.database || 'master' }}</div>
            </div>

            <div class="row__cell row__cell--wide">
              <div class="row__endpoint mono truncate">{{ endpoint(connection) }}</div>
              <div class="row__sub truncate">{{ route(connection) }}</div>
            </div>

            <div class="row__cell">
              <span v-if="transportBadge(connection)" class="badge badge--accent">
                {{ transportBadge(connection) }}
              </span>
            </div>

            <div class="row__cell">
              <span class="badge">{{ connection.authType === 'windows' ? 'NTLM' : 'SQL' }}</span>
            </div>

            <div class="row__cell row__cell--right row__time">
              <div class="truncate">{{ relativeTime(connection.lastUsedAt) }}</div>
              <div v-if="createdOn(connection.createdAt)" class="row__sub truncate">
                created {{ createdOn(connection.createdAt) }}
              </div>
            </div>

            <div class="row__buttons">
              <!-- Read-only, switched without opening the form or connecting:
                   on at once, off once asked. On every row, so it is there to
                   be found; the badge by the name says which way it is. -->
              <button
                class="btn btn--sm btn--muted btn--icon row__lock"
                :class="{ 'btn--armed': connection.readOnly }"
                :title="
                  connection.readOnly
                    ? 'Read-only — click to turn it off'
                    : 'Make this connection read-only'
                "
                :aria-label="`Read-only for ${connection.name}`"
                :aria-pressed="connection.readOnly === true"
                @click.stop="readOnly.setReadOnly(connection, !connection.readOnly)"
                @dblclick.stop
              >
                <AppIcon :name="connection.readOnly ? 'lock' : 'lock-open'" :size="15" />
              </button>
              <button
                class="btn btn--sm row__connect"
                :disabled="connections.connectingId === connection.id"
                @click.stop="open(connection)"
              >
                <span v-if="connections.connectingId === connection.id" class="spinner"></span>
                Connect
              </button>
              <!-- Connect is what a row is for; everything else it can do is
                   behind here, and behind a right-click as it always was. -->
              <button
                class="btn btn--sm btn--muted btn--icon row__menu"
                title="Edit, duplicate, delete"
                :aria-label="`More for ${connection.name}`"
                aria-haspopup="menu"
                :aria-expanded="menu?.connection?.id === connection.id"
                @mousedown.stop
                @click.stop="toggleRowMenu(connection, $event)"
                @dblclick.stop
              >
                <AppIcon name="more" :size="16" />
              </button>
            </div>
          </div>
            </template>
          </template>
        </div>
      </div>
    </div>

    <footer class="screen__foot muted">
      <template v-if="settings.appInfo">
        <span>v{{ settings.appInfo.version }}</span>
        <span class="screen__foot-sep" aria-hidden="true">·</span>
        <span>Electron {{ settings.appInfo.electronVersion }}</span>
        <span class="screen__foot-sep" aria-hidden="true">·</span>
        <span>
          {{
            settings.appInfo.secretsAreOsBacked
              ? 'secrets in the OS keystore'
              : 'secrets encrypted with a local key file'
          }}
        </span>
      </template>
    </footer>

    <BaseModal
      v-if="showForm"
      :kicker="formKicker"
      :title="editing?.name || 'Untitled connection'"
      width="720px"
      flush
      @close="showForm = false"
    >
      <ConnectionForm
        ref="connectionForm"
        :connection="editing"
        :busy="testing"
        :groups="connections.groups"
        :saved-names="connections.saved.map((entry) => entry.name)"
        :table-plus-open="tablePlusOpen"
        :select-name="Boolean(copiedFrom)"
        @save="save"
        @duplicate="saveAsCopy"
        @test="test"
        @cancel="showForm = false"
      />
    </BaseModal>

    <BaseModal
      v-if="passwordPrompt"
      :title="`Password for ${passwordPrompt.connection.name}`"
      :subtitle="passwordPrompt.connection.username"
      width="400px"
      @close="passwordPrompt = null"
    >
      <form @submit.prevent="open(passwordPrompt!.connection, passwordPrompt!.value)">
        <label class="field">
          <span class="field__label">Password</span>
          <!-- eslint-disable-next-line vuejs-accessibility/no-autofocus -->
          <input
            v-model="passwordPrompt.value"
            class="input"
            type="password"
            autofocus
            autocomplete="current-password"
          />
        </label>
      </form>
      <template #footer>
        <button class="btn" @click="passwordPrompt = null">Cancel</button>
        <button
          class="btn btn--primary"
          @click="open(passwordPrompt!.connection, passwordPrompt!.value)"
        >
          Connect
        </button>
      </template>
    </BaseModal>

    <!--
      Keyed on where it was opened: a right-click closes the open menu on its
      way in, but the ⋮ button does not, and a menu that is patched rather than
      remounted keeps the position it measured for the row above.
    -->
    <ContextMenu
      v-if="menu"
      :key="menu.key"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      @select="onMenuSelect"
      @close="menu = null"
    />
  </div>
</template>

<style scoped>
/* The seven tracks the header and every row share. */
.screen {
  --conn-cols: 64px minmax(0, 1.5fr) minmax(0, 2fr) 92px 92px 140px 170px;
  /* Content keeps to a readable measure, centred, however wide the window. */
  --screen-gutter: max(32px, calc((100% - 1120px) / 2));
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
}
.screen__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
  padding: 32px var(--screen-gutter) 8px;
  flex: 0 0 auto;
}
.brand {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}
.brand__mark {
  box-shadow: var(--shadow-sm);
  border-radius: 10px;
}
.brand__text {
  min-width: 0;
}
.brand__title {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  line-height: 1.15;
  letter-spacing: -0.02em;
}
.brand__sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-muted);
}
.screen__actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex: 0 0 auto;
}
.screen__theme {
  display: grid;
  place-items: center;
  width: var(--h-control-lg);
  height: var(--h-control-lg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-control);
  box-shadow: var(--shadow-xs);
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background-color var(--transition),
    border-color var(--transition),
    color var(--transition);
}
.screen__theme:hover {
  border-color: var(--border-hover);
  background: var(--bg-control-hover);
  color: var(--text-primary);
}
.screen__theme:focus-visible {
  outline-offset: 2px;
}
.screen__more[aria-expanded='true'] {
  background: var(--bg-active);
  color: var(--text-primary);
}

.screen__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 20px var(--screen-gutter) 24px;
  overflow: hidden;
}
/* Search takes the width it is given; the sort control keeps its own. */
.screen__tools {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 0 0 auto;
}
.screen__search {
  display: flex;
  align-items: center;
  gap: 9px;
  height: var(--h-control-lg);
  padding: 0 12px 0 11px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  box-shadow: var(--shadow-xs);
  max-width: 420px;
  flex: 1 1 420px;
  min-width: 0;
  transition:
    border-color var(--transition),
    box-shadow var(--transition);
}
.screen__search:hover {
  border-color: var(--border-hover);
}
.screen__search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.screen__search-glyph {
  color: var(--text-muted);
}
.screen__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  user-select: text;
}
.screen__search-input::placeholder {
  color: var(--text-muted);
}

.screen__sort {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  margin-left: auto;
}
.screen__sort-label {
  white-space: nowrap;
}
.screen__sort-select {
  width: auto;
  min-width: 132px;
  height: var(--h-control-lg);
}
/* Square, and the search field's height: the three read as one strip. */
.screen__sort-flip {
  width: var(--h-control-lg);
  height: var(--h-control-lg);
  padding: 0;
  font-size: 15px;
  color: var(--text-secondary);
}
.screen__sort-flip:hover:not(:disabled) {
  color: var(--text-primary);
}

/* --- the connection table -------------------------------------------------- */
.table {
  display: flex;
  flex-direction: column;
  flex: 0 1 auto;
  min-height: 0;
  margin-top: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-surface);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
}
.table__head {
  display: grid;
  grid-template-columns: var(--conn-cols);
  align-items: center;
  height: 36px;
  border-bottom: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-app) 50%, var(--bg-surface));
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.table__cell {
  padding: 0 8px;
}
.table__cell--wide {
  padding: 0 14px;
}
.table__cell--right {
  text-align: right;
}
.table__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* A heading, not a row: it spans the tracks instead of sitting in them. */
.group {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  padding: 0 18px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-app) 30%, var(--bg-surface));
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  position: sticky;
  top: 0;
  z-index: 1;
  transition: color var(--transition);
}
.group:hover {
  color: var(--text-primary);
}
.group__caret {
  color: var(--text-muted);
  transition: transform var(--transition);
}
.group__caret--open {
  transform: rotate(90deg);
}
.group__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The bucket rather than a group anyone named, so it is said more quietly. */
.group__name--none {
  color: var(--text-muted);
}
.group__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  color: var(--text-muted);
  font-size: 10px;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}

.row {
  display: grid;
  grid-template-columns: var(--conn-cols);
  align-items: center;
  height: 60px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background-color var(--transition);
}
.row:last-child {
  border-bottom: none;
}
.row:hover {
  background: var(--bg-hover);
}
.row--busy {
  opacity: 0.75;
}
/* The connection's colour on a tile at the head of the row. */
.row__avatar {
  display: grid;
  place-items: center;
  justify-self: end;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  color: #ffffff;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    var(--shadow-xs);
}
.row__avatar--plain {
  border: 1px solid var(--border-strong);
  background: var(--bg-raised);
  color: var(--text-muted);
  box-shadow: none;
}
.row__cell {
  padding: 0 8px;
  min-width: 0;
}
.row__cell--wide {
  padding: 0 14px;
}
.row__cell--right {
  text-align: right;
}
.row__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.row__name {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
}
.row__readonly,
.row__confirms {
  flex: 0 0 auto;
  gap: 4px;
}
/* A narrow window leaves the name cell little room, and the name is what the
   row is for: the badge gives up its word before the name gives up its
   letters, and keeps the lock (and its title) to say the same thing. */
.row__identity {
  container-type: inline-size;
}
@container (max-width: 240px) {
  .row__readonly-label {
    display: none;
  }
}
.row__endpoint {
  font-size: 12px;
  color: var(--text-secondary);
}
.row__sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 3px;
}
.row__time {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.row__time .row__sub {
  font-size: 11px;
  color: var(--text-dim);
}
.row__buttons {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  padding: 0 14px 0 8px;
}
.row__buttons .btn {
  height: 28px;
}
/* A quiet button at rest; the row being pointed at makes it the action. */
.row:hover .row__connect:not(:disabled),
.row:focus-within .row__connect:not(:disabled) {
  border-color: transparent;
  background: var(--accent);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    var(--shadow-sm);
  color: var(--accent-text);
}
.row:hover .row__connect:not(:disabled):hover {
  background: var(--accent-hover);
}
.row__menu,
.row__lock {
  width: 28px;
}
.row__menu[aria-expanded='true'] {
  background: var(--bg-active);
  color: var(--text-primary);
}

.screen__foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: var(--h-statusbar);
  padding: 0 32px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-app);
  font-size: 12px;
  color: var(--text-dim);
  flex: 0 0 auto;
}
.screen__foot-sep {
  color: var(--text-dim);
}
</style>
