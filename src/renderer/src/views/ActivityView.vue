<script setup lang="ts">
/**
 * The activity monitor: the server's sessions, what each is running, what it
 * waits on, and who is blocking whom — with Kill for the one that has to go.
 *
 * It reads the DMVs through the window's shared pool, never a query tab's
 * session, so watching the server never waits on a tab's run. A login that
 * cannot see the others' sessions is told which permission it lacks rather
 * than shown a list of one.
 */
import { computed, markRaw, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
import type { ActivitySession, ServerActivity } from '@shared/types'
import AppIcon from '../components/AppIcon.vue'
import ChoiceMenu from '../components/ChoiceMenu.vue'
import {
  AUTO_REFRESH_CHOICES,
  autoRefreshChoice,
  createAutoRefresher
} from '../lib/autoRefresh'
import { blockingChains, formatDuration, visibleSessions } from '../lib/activity'
import { useConfirmStore } from '../stores/confirm'
import { useConnectionStore } from '../stores/connections'
import { useTabStore, type ActivityTab } from '../stores/tabs'
import { useToastStore } from '../stores/toasts'
import { api } from '../lib/api'

const props = defineProps<{ tab: ActivityTab }>()
const emit = defineEmits<{ (event: 'open-sql', sql: string, title: string): void }>()

const tabs = useTabStore()
const toasts = useToastStore()
const confirm = useConfirmStore()
const connections = useConnectionStore()

/**
 * What this tab showed when it was last on screen, read here in setup so the
 * first render draws it: a monitor picked again comes back as it was left,
 * rather than empty while it asks the server again.
 */
const cached = props.tab.cache
const activity = ref<ServerActivity | null>(cached?.activity ?? null)
const loading = ref(false)
const error = ref<string | null>(null)
const filter = ref(cached?.filter ?? '')
const selectedId = ref<number | null>(null)
const body = ref<HTMLElement | null>(null)

const connected = computed(
  () => connections.statusFor(props.tab.connectionId).state === 'connected'
)
const readOnly = computed(() => connections.statusFor(props.tab.connectionId).readOnly === true)
const showIdle = computed(() => props.tab.showIdle === true)

/** Reads the server again; resolves false when the read failed. */
async function load(): Promise<boolean> {
  if (loading.value) return true
  loading.value = true
  try {
    activity.value = await api.readActivity(props.tab.connectionId)
    error.value = null
    return true
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
    return false
  } finally {
    loading.value = false
  }
}

const sessions = computed(() => activity.value?.sessions ?? [])
const chains = computed(() => blockingChains(sessions.value))
const heads = computed(() => new Set(chains.value.map((chain) => chain.head.sessionId)))
const rows = computed(() =>
  visibleSessions(sessions.value, {
    showIdle: showIdle.value,
    filter: filter.value,
    blockers: heads.value
  })
)
const selected = computed(
  () => sessions.value.find((session) => session.sessionId === selectedId.value) ?? null
)

const summary = computed(() => {
  const all = sessions.value
  const running = all.filter((session) => session.sqlIsCurrent).length
  const blocked = all.filter((session) => session.blockedBy !== null).length
  return { total: all.length, running, blocked }
})

/** This window's query tab a session is, by its title. */
function tabOf(session: ActivitySession): string | null {
  const id = activity.value?.tabSessions[session.sessionId]
  return id ? (tabs.tabs.find((tab) => tab.id === id)?.title ?? null) : null
}

function isMonitor(session: ActivitySession): boolean {
  return session.sessionId === activity.value?.monitorSessionId
}

/** Who a session is, in one line: login, host and program. */
function who(session: ActivitySession): string {
  return [session.login, session.host && `on ${session.host}`, session.program && `· ${session.program}`]
    .filter(Boolean)
    .join(' ')
}

function oneLine(sql: string | null): string {
  return sql ? sql.replace(/\s+/g, ' ').trim() : ''
}

/** The wait as the monitor states it: its type and for how long. */
function waitLabel(session: ActivitySession): string {
  if (!session.waitType) return ''
  return `${session.waitType} ${formatDuration(session.waitTimeMs)}`
}

const killTitle = computed(() =>
  readOnly.value ? 'This connection is read-only, so no session can be killed' : 'Kill this session'
)

/**
 * Ends a session once asked. Its statement stops and its transaction is
 * rolled back by the server — which takes as long as the work being undone
 * did, so it is worth saying before rather than after.
 */
async function kill(session: ActivitySession): Promise<void> {
  if (readOnly.value || isMonitor(session)) return
  const tab = tabOf(session)
  const notes = [
    'Its running statement stops, and anything its open transaction changed is rolled back — which can take as long as the work did.'
  ]
  if (tab) notes.push(`It is the session of the query tab “${tab}”, which loses its temp tables, settings and transaction.`)
  else if (session.ownProcess) notes.push('It is one of TableView’s own connections.')
  const proceed = await confirm.ask({
    kicker: 'Session',
    title: `Kill session ${session.sessionId}?`,
    message: notes.join(' '),
    action: 'Kill'
  })
  if (!proceed) return
  try {
    await api.killSession(props.tab.connectionId, session.sessionId, true)
    toasts.success(`Session ${session.sessionId} was killed`)
  } catch (failure) {
    toasts.fromError(`Could not kill session ${session.sessionId}`, failure)
  }
  await load()
}

async function copySql(session: ActivitySession): Promise<void> {
  if (!session.sql) return
  await api.copyToClipboard(session.sql)
  toasts.info('Copied the statement')
}

// --- auto refresh -------------------------------------------------------------

const autoRefresh = computed(() => props.tab.autoRefresh ?? 0)

const autoRefresher = createAutoRefresher({
  hold: () =>
    !connected.value ||
    loading.value ||
    confirm.question !== null ||
    document.visibilityState === 'hidden',
  refresh: load,
  onFailure: () => {
    tabs.update<ActivityTab>(props.tab.id, { autoRefresh: 0 })
    toasts.error('Stopped refreshing the activity', error.value ?? undefined)
  }
})
watch(autoRefresh, (ms) => autoRefresher.set(ms), { immediate: true })

const AUTO_REFRESH_MENU = AUTO_REFRESH_CHOICES.map((choice) => ({
  value: choice.ms,
  label: choice.label
}))
const autoButton = ref<HTMLButtonElement | null>(null)
const autoMenuOpen = ref(false)

function chooseAutoRefresh(ms: number): void {
  tabs.update<ActivityTab>(props.tab.id, { autoRefresh: ms })
  autoRefresher.set(ms, true)
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') autoRefresher.now()
}
document.addEventListener('visibilitychange', onVisibilityChange)

// Read when it opens, and again when the connection comes back. A tab picked
// again has what it read last time to show, and reads afresh only if it
// refreshes itself — its timer stopped while it was away.
if (connected.value && (!cached || autoRefresh.value > 0)) void load()
watch(connected, (now) => {
  if (now) void load()
})

onMounted(() => {
  if (cached && body.value) body.value.scrollTop = cached.scrollTop
})

onBeforeUnmount(() => {
  autoRefresher.dispose()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  // Picking another tab takes this view down: what it read, and where the
  // reader was in it, stay on the tab for the next view of it.
  if (!activity.value) return
  tabs.update<ActivityTab>(props.tab.id, {
    cache: markRaw({
      activity: toRaw(activity.value),
      filter: filter.value,
      scrollTop: body.value?.scrollTop ?? 0
    })
  })
})

defineExpose({ refresh: () => void load() })
</script>

<template>
  <div class="activity">
    <div class="activity__toolbar">
      <AppIcon class="activity__icon" name="activity" :size="15" />
      <span class="activity__title">Activity</span>
      <span v-if="activity" class="activity__counts num">
        {{ summary.total }} {{ summary.total === 1 ? 'session' : 'sessions' }} ·
        {{ summary.running }} running
        <template v-if="summary.blocked">
          · <span class="activity__blocked">{{ summary.blocked }} blocked</span>
        </template>
      </span>
      <span v-if="loading" class="spinner activity__spinner"></span>

      <div class="activity__spacer"></div>

      <label class="activity__filter">
        <AppIcon class="activity__filter-glyph" name="search" :size="13" />
        <input
          v-model="filter"
          class="input activity__filter-input"
          placeholder="Filter sessions"
          aria-label="Filter sessions by login, host, program, database or statement"
        />
      </label>
      <button
        class="btn activity__tool"
        :class="{ 'btn--armed': showIdle }"
        :aria-pressed="showIdle"
        title="Also list sleeping sessions that hold no transaction open"
        @click="tabs.update<ActivityTab>(tab.id, { showIdle: !showIdle })"
      >
        <AppIcon :name="showIdle ? 'eye' : 'eye-off'" :size="14" />
        Idle sessions
      </button>
      <button
        class="btn activity__tool"
        :disabled="loading || !connected"
        title="Read the server's sessions again (F5)"
        @click="load"
      >
        <AppIcon name="refresh" :size="14" />
        Refresh
      </button>
      <button
        ref="autoButton"
        class="btn activity__tool activity__auto"
        :class="{ 'btn--armed': autoRefresh > 0 }"
        :title="autoMenuOpen ? undefined : 'Refresh the activity automatically'"
        :aria-label="`Refresh automatically: ${autoRefreshChoice(autoRefresh).label}`"
        aria-haspopup="menu"
        :aria-expanded="autoMenuOpen"
        @click="autoMenuOpen = !autoMenuOpen"
      >
        <span v-if="autoRefresh > 0" class="activity__auto-dot"></span>
        <AppIcon v-else name="clock" :size="14" />
        Auto
        <span class="activity__auto-value">{{ autoRefreshChoice(autoRefresh).short }}</span>
        <AppIcon name="chevron-down" :size="12" />
      </button>
      <ChoiceMenu
        v-if="autoMenuOpen"
        :anchor="autoButton"
        label="Refresh automatically"
        :choices="AUTO_REFRESH_MENU"
        :value="autoRefresh"
        @choose="chooseAutoRefresh"
        @close="autoMenuOpen = false"
      />
    </div>

    <div v-if="activity?.missingPermission" class="activity__banner activity__banner--warn" role="status">
      <AppIcon name="lock" :size="14" />
      <span>
        This login can see only its own session. Seeing the others needs
        <strong class="mono">{{ activity.missingPermission }}</strong> — granted with
        <span class="mono selectable">GRANT {{ activity.missingPermission }} TO [login]</span>.
      </span>
    </div>
    <div v-if="error" class="activity__banner activity__banner--error" role="alert">
      <AppIcon name="circle-x" :size="14" />
      <span class="selectable">{{ error }}</span>
    </div>

    <div ref="body" class="activity__body">
      <section v-if="chains.length" class="chains" aria-label="Blocking">
        <div class="activity__heading caps">
          Blocking
          <span class="activity__heading-count">{{ chains.length }}</span>
        </div>
        <div v-for="chain in chains" :key="chain.head.sessionId" class="chain">
          <button
            v-for="link in chain.links"
            :key="link.session.sessionId"
            class="chain__link"
            :class="{
              'chain__link--head': link.depth === 0,
              'chain__link--on': link.session.sessionId === selectedId
            }"
            :style="{ paddingLeft: `${10 + link.depth * 20}px` }"
            @click="selectedId = link.session.sessionId"
          >
            <AppIcon
              v-if="link.depth > 0"
              class="chain__elbow"
              name="corner-down-left"
              :size="12"
            />
            <span class="chain__id num">{{ link.session.sessionId }}</span>
            <span v-if="link.depth === 0" class="badge badge--danger">head blocker</span>
            <span class="chain__who truncate">{{ who(link.session) || link.session.status }}</span>
            <span v-if="link.depth > 0" class="chain__wait mono">{{ waitLabel(link.session) }}</span>
            <span v-else-if="link.session.openTransactions" class="chain__wait">
              {{ link.session.status }} · transaction open
            </span>
            <span class="chain__sql mono truncate">{{ oneLine(link.session.sql) }}</span>
          </button>
        </div>
      </section>

      <table class="sessions">
        <thead>
          <tr>
            <th class="num">Session</th>
            <th>Status</th>
            <th>Login</th>
            <th>Host</th>
            <th>Program</th>
            <th>Database</th>
            <th>Wait</th>
            <th class="num">Blocked by</th>
            <th class="num">CPU</th>
            <th class="num">Reads</th>
            <th class="num">Elapsed</th>
            <th class="num" title="Open transactions">Tran</th>
            <th>Statement</th>
            <th aria-label="Actions"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="session in rows"
            :key="session.sessionId"
            :class="{
              'sessions__row--on': session.sessionId === selectedId,
              'sessions__row--blocked': session.blockedBy !== null,
              'sessions__row--head': heads.has(session.sessionId)
            }"
            :data-session="session.sessionId"
            @click="selectedId = session.sessionId"
          >
            <td class="num">
              <span class="sessions__id">{{ session.sessionId }}</span>
              <span
                v-if="isMonitor(session)"
                class="badge badge--accent"
                title="The session this monitor read the server on"
                >monitor</span
              >
              <span v-else-if="tabOf(session)" class="badge badge--accent" :title="`The query tab ${tabOf(session)}`">
                tab
              </span>
              <span
                v-else-if="session.ownProcess"
                class="badge"
                title="One of this TableView's own connections"
                >TableView</span
              >
            </td>
            <td>{{ session.status }}</td>
            <td class="truncate">{{ session.login }}</td>
            <td class="truncate">{{ session.host }}</td>
            <td class="truncate">{{ session.program }}</td>
            <td class="truncate mono">{{ session.database }}</td>
            <td class="mono truncate" :title="session.waitResource ?? undefined">{{ waitLabel(session) }}</td>
            <td class="num">
              <span v-if="session.blockedBy !== null" class="activity__blocked">{{ session.blockedBy }}</span>
            </td>
            <td class="num">{{ session.cpuMs.toLocaleString() }}</td>
            <td class="num">{{ session.logicalReads.toLocaleString() }}</td>
            <td class="num">{{ formatDuration(session.elapsedMs) }}</td>
            <td class="num">{{ session.openTransactions || '' }}</td>
            <td class="mono truncate sessions__sql" :class="{ dim: !session.sqlIsCurrent }">
              {{ oneLine(session.sql) }}
            </td>
            <td class="sessions__actions">
              <button
                class="btn btn--sm btn--ghost btn--icon"
                :disabled="readOnly || isMonitor(session)"
                :title="isMonitor(session) ? 'The monitor cannot kill its own session' : killTitle"
                :aria-label="`Kill session ${session.sessionId}`"
                @click.stop="kill(session)"
              >
                <AppIcon name="power" :size="13" />
              </button>
            </td>
          </tr>
          <tr v-if="activity && rows.length === 0">
            <td class="sessions__empty" colspan="14">
              {{ filter ? 'No session matches the filter' : 'No session is running anything — Idle sessions lists the rest' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="selected" class="detail">
      <div class="detail__head">
        <strong class="num">Session {{ selected.sessionId }}</strong>
        <span class="detail__who truncate">{{ who(selected) }}</span>
        <span v-if="tabOf(selected)" class="badge badge--accent">tab {{ tabOf(selected) }}</span>
        <div class="activity__spacer"></div>
        <button class="btn btn--sm" :disabled="!selected.sql" @click="copySql(selected)">
          <AppIcon name="copy" :size="13" />
          Copy statement
        </button>
        <button
          class="btn btn--sm"
          :disabled="!selected.sql"
          @click="selected.sql && emit('open-sql', selected.sql, `Session ${selected.sessionId}`)"
        >
          <AppIcon name="terminal" :size="13" />
          Open in a query tab
        </button>
        <button
          class="btn btn--sm btn--danger"
          :disabled="readOnly || isMonitor(selected)"
          :title="killTitle"
          @click="kill(selected)"
        >
          <AppIcon name="power" :size="13" />
          Kill
        </button>
        <button
          class="btn btn--sm btn--ghost btn--icon"
          title="Close"
          aria-label="Close the session's details"
          @click="selectedId = null"
        >
          <AppIcon name="x" :size="13" />
        </button>
      </div>
      <div class="detail__meta">
        <span>{{ selected.sqlIsCurrent ? 'Running' : 'Last statement' }}</span>
        <span v-if="selected.database">in <span class="mono">{{ selected.database }}</span></span>
        <span v-if="selected.command">· {{ selected.command }}</span>
        <span v-if="selected.waitResource">· waiting on <span class="mono">{{ selected.waitResource }}</span></span>
        <span v-if="selected.loginTime">· logged in {{ new Date(selected.loginTime).toLocaleString() }}</span>
      </div>
      <pre class="detail__sql mono selectable">{{ selected.sql ?? 'No statement' }}</pre>
    </div>
  </div>
</template>

<style scoped>
.activity {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-surface);
}
.activity__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--h-commandbar);
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--border-subtle);
  flex: 0 0 auto;
}
.activity__icon {
  color: var(--text-muted);
}
.activity__title {
  font-weight: 600;
}
.activity__counts {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}
.activity__blocked {
  color: var(--danger);
  font-weight: 600;
}
.activity__spinner {
  width: 12px;
  height: 12px;
}
.activity__spacer {
  flex: 1;
}
.activity__tool {
  flex: 0 0 auto;
}
.activity__filter {
  position: relative;
  display: flex;
  align-items: center;
}
.activity__filter-glyph {
  position: absolute;
  left: 8px;
  color: var(--text-muted);
  pointer-events: none;
}
.activity__filter-input {
  width: 200px;
  height: var(--h-control);
  padding-left: 26px;
  font-size: 12px;
}
.activity__auto-value {
  font-variant-numeric: tabular-nums;
}
.activity__auto-dot {
  width: 7px;
  height: 7px;
  margin: 0 2px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.activity__banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
  line-height: 1.5;
  flex: 0 0 auto;
}
.activity__banner > .icon {
  margin-top: 2px;
  flex: 0 0 auto;
}
.activity__banner--warn {
  background: color-mix(in srgb, var(--warning) 10%, var(--bg-surface));
  color: var(--text-primary);
}
.activity__banner--warn > .icon {
  color: var(--warning);
}
.activity__banner--error {
  background: color-mix(in srgb, var(--danger) 10%, var(--bg-surface));
  color: var(--text-primary);
}
.activity__banner--error > .icon {
  color: var(--danger);
}
.activity__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.activity__heading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px 6px;
  color: var(--danger);
}
.activity__heading-count {
  color: var(--text-muted);
}
.chains {
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: 8px;
}
.chain {
  margin: 0 8px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.chain__link {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding-right: 10px;
  border: 0;
  border-top: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.chain__link:first-child {
  border-top: 0;
}
.chain__link:hover {
  background: var(--bg-hover);
}
.chain__link--head {
  background: color-mix(in srgb, var(--danger) 7%, transparent);
  color: var(--text-primary);
}
.chain__link--on {
  background: var(--accent-soft);
}
.chain__elbow {
  color: var(--text-dim);
  transform: scaleX(-1);
  flex: 0 0 auto;
}
.chain__id {
  min-width: 28px;
  font-weight: 600;
  color: var(--text-primary);
}
.chain__who {
  flex: 0 1 auto;
  max-width: 280px;
}
.chain__wait {
  flex: 0 0 auto;
  color: var(--warning);
}
.chain__sql {
  flex: 1;
  min-width: 0;
  color: var(--text-muted);
}
.badge--danger {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}
.sessions {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
  font-size: 12px;
}
.sessions th {
  position: sticky;
  top: 0;
  z-index: 1;
  height: 32px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-app);
  color: var(--text-muted);
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}
.sessions td {
  height: 30px;
  max-width: 220px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  white-space: nowrap;
}
.sessions .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.sessions tbody tr {
  cursor: default;
}
.sessions tbody tr:hover td {
  background: var(--bg-hover);
}
.sessions__row--on td,
.sessions__row--on:hover td {
  background: var(--bg-selected);
}
.sessions__row--head td:first-child {
  box-shadow: inset 2px 0 0 var(--danger);
}
.sessions__row--blocked td:first-child {
  box-shadow: inset 2px 0 0 var(--warning);
}
.sessions__id {
  color: var(--text-primary);
  font-weight: 600;
}
.sessions td .badge {
  margin-left: 6px;
}
.sessions__sql {
  max-width: 420px;
}
.sessions__actions {
  width: 1%;
  text-align: right;
}
.sessions__empty {
  padding: 20px 14px !important;
  color: var(--text-muted) !important;
  text-align: center;
}
.detail {
  display: flex;
  flex-direction: column;
  max-height: 40%;
  min-height: 140px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-app);
  flex: 0 0 auto;
}
.detail__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--h-gridheader);
  padding: 0 10px 0 14px;
  flex: 0 0 auto;
}
.detail__who {
  min-width: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.detail__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 14px 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.detail__sql {
  flex: 1;
  min-height: 0;
  margin: 0 14px 12px;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
}
</style>
