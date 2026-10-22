# Query Tab Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every query tab a SQL Server session of its own, from its first run until it
closes. An open transaction shows on its tab and is never ended without asking.

**Architecture:**

- **Main process:** each query tab's runs go to a `QuerySession`, which holds exactly one
  connection: a one-connection mssql pool that refuses to replace its connection. The window's
  shared pool stays for everything else: the schema tree, table tabs, completion and keepalive.
- **What the tab is told:** after every run the main process reads the session's state
  (`@@TRANCOUNT`, `XACT_STATE()`, `DB_NAME()`) and returns it with the result. Changes that
  happen without a run (a database switch moved the session, or it was lost) go to the window as
  an event.
- **Renderer:** the tab keeps that state. It draws a marker, a toolbar badge and a status-bar
  count from it, and decides what to ask before anything would end the session.

**Tech Stack:** Electron, Vue 3 + Pinia, TypeScript, mssql 12.7 (tedious 20, tarn 3), Vitest. The
integration tests run against the SQL Server 2022 container; the e2e tests use Electron driven over
CDP.

**Spec:** `docs/superpowers/specs/2026-10-21-query-tab-sessions-design.md` (issue #31). Read it
first; this plan argues from it.

## Global Constraints

- **No Electron in `db`:** `src/main/db/**` never imports Electron.
- **Read-only:** enforced in the main process. A session run goes through the same check as
  `runScript` (`findWrite` / `findWriteInScript`) before anything is sent.
- **Identifiers:** values are bound, and identifiers are interpolated only through
  `src/shared/sql/identifiers.ts`. The `USE` the app sends uses `quoteIdent`.
- **Batches:** scripts split on `GO` (`splitBatches`).
- **Sessionless runs unchanged:** a `RunQueryRequest` without `sessionId` runs on the shared pool
  exactly as today. The e2e helpers and the integration tests call it that way.
- **IPC wiring:** an IPC addition touches `src/shared/ipc.ts`, `src/main/ipc/index.ts` and
  `src/preload/index.ts`. `src/renderer/src/lib/api.ts` is a Proxy and needs no change.
- **UI:** uses `design-system/tableview/MASTER.md` and the tokens in `styles/index.css`. Open
  transactions use `--warning`, the palette's colour for staged work. Icons come from
  `lib/icons.ts` (`clock`, `database`, `info`). Class names and button text that
  `test/e2e/*.mjs` reads stay as they are.
- **Copy fixed by the spec:**
  - lost session: *This tab's session was closed — temp tables and settings from earlier runs are
    gone*, plus *its open transaction was rolled back by the server*;
  - toolbar: *Transaction open*;
  - buttons: **Commit**, **Rollback**, **Commit and …**, **Roll back and …**, **Stop and roll
    back**, **Cancel**. Cancel has the focus.
- **Numbers:** a running query gets up to **10 seconds** to stop before a close goes ahead anyway.
  Session heartbeats use the connection's `keepAliveIntervalMs`.
- **Release:** version **0.3.0** via `npm version minor --no-git-tag-version`, with a
  `CHANGELOG.md` section `## 0.3.0`. Never create or push a `v*` tag.

## Review Focus

- **No database named:** a connection with no database in its settings gets the login's default.
  Sessions must open in the window's actual database (`DB_NAME()` of the shared pool), and must
  compare against it. Test in Task 4.
- **Awkward database names:** names with spaces or `]` are switched to correctly (the app's `USE`
  quotes them). Test in Task 5.
- **Cancelled runs:** a run cancelled mid-transaction still reports the open transaction, so the
  marker appears. Test in Task 4.
- **Split copies:** splitting a query tab copies the tab (`copyOf` spreads it); the copy must not
  claim the original's session. Test in Task 8.
- **Read-only connections:** a write is refused before the session is touched, while
  `BEGIN TRAN` / `COMMIT` (including the app's own `COMMIT_SQL`) go through. Test in Task 4.

---

## Files

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` (modify) | `SessionState`, `SessionLoss`, `SessionEvent`, `SESSION_LOST`; request/result fields |
| `src/shared/sessions.ts` (create) | Pure rules and copy both sides use: follow-or-stay, refuse-or-run, notes, ages |
| `src/main/db/sqlserver/config.ts` (modify) | `buildSessionConfig`: a one-connection, never-replaced pool config |
| `src/main/db/sqlserver/session.ts` (create) | `QuerySession`: holds one connection, reads its state, knows when it is lost |
| `src/main/db/types.ts` (modify) | `DbClient` gains `runInSession`, `closeSession`, `onSessionChange` |
| `src/main/db/sqlserver/client.ts` (modify) | Sessions per tab; database switch moves them; drops and keepalive reach them |
| `src/main/db/registry.ts` (modify) | Routes a client's session changes to the window that owns it |
| `src/shared/ipc.ts`, `src/main/ipc/index.ts`, `src/preload/index.ts` (modify) | `query:closeSession`, `event:sessionChanged`, session fields on `query:run` |
| `src/renderer/src/lib/tabSessions.ts` (create) | `endSession`, `stopRun`: what the store asks the main process to do |
| `src/renderer/src/stores/tabs.ts` (modify) | Tab session state; the questions before a session ends |
| `src/renderer/src/lib/runQueryTab.ts` (modify) | Runs on the tab's session; keeps what it reports |
| `src/renderer/src/components/OpenTransactionDialog.vue` (create) | The question, and its Commit / Roll back / Stop answers |
| `src/renderer/src/views/QueryView.vue`, `components/TabBar.vue`, `components/StatusBar.vue`, `App.vue`, `views/WorkspaceView.vue` (modify) | Showing the session; subscribing to its events; mounting the dialog |

---

### Task 1: Shared session vocabulary and rules

**Files:**
- Modify: `src/shared/types.ts` (beside `QueryExecutionResult` / `RunQueryRequest`, ~line 266)
- Create: `src/shared/sessions.ts`
- Test: `test/unit/sessions.test.ts`

**Interfaces:**
- Produces, in `src/shared/types.ts`:
  ```ts
  export const SESSION_LOST = 'SESSION_LOST'
  export interface SessionState {
    transactionCount: number          // @@TRANCOUNT
    transactionState: -1 | 0 | 1      // XACT_STATE()
    database: string                  // DB_NAME()
    transactionSince?: string         // ISO time the open transaction was first seen
  }
  export interface SessionLoss { had: SessionState; refused: boolean }
  export interface SessionEvent { connectionId: string; sessionId: string; state: SessionState | null; lost?: SessionState }
  // RunQueryRequest gains:     sessionId?: string; pinnedDatabase?: string
  // QueryExecutionResult gains: session?: SessionState; sessionLost?: SessionLoss
  ```
- Produces, in `src/shared/sessions.ts`:
  ```ts
  export const COMMIT_SQL = 'WHILE @@TRANCOUNT > 0 COMMIT TRANSACTION;'
  export const ROLLBACK_SQL = 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;'
  export const STATE_SQL = 'SELECT @@TRANCOUNT AS transactionCount, XACT_STATE() AS transactionState, DB_NAME() AS [database];'
  export function sameDatabase(a: string | null | undefined, b: string | null | undefined): boolean
  export interface SessionPlace { database: string; transactionCount: number; pinned: boolean; running: boolean }
  export type FollowDecision = 'follow' | 'stay' | 'later'
  export function followDecision(session: SessionPlace, fromDatabase: string): FollowDecision
  export function refuseAfterLoss(had: SessionState, nextDatabase: string): boolean
  export function withTransactionSince(previous: SessionState | null | undefined, next: Omit<SessionState, 'transactionSince'>, now: Date): SessionState
  export function transactionOpen(session: SessionState | null | undefined): boolean
  export function canCommit(session: SessionState | null | undefined): boolean
  export function transactionAge(since: string | undefined, now: Date): string
  export function lostSessionNote(had: SessionState): string
  export function lostSessionRefusal(had: SessionState, nextDatabase: string): string
  ```

- [ ] **Step 1: Write the failing tests** in `test/unit/sessions.test.ts`:

```ts
const state = (over: Partial<SessionState> = {}): SessionState =>
  ({ transactionCount: 0, transactionState: 0, database: 'sales', ...over })

describe('sameDatabase', () => {
  it('compares names the way SQL Server usually does, without case', () => {
    expect(sameDatabase('Sales', 'sales')).toBe(true)
    expect(sameDatabase('sales', 'master')).toBe(false)
    expect(sameDatabase(undefined, 'sales')).toBe(false)
  })
})

describe('followDecision', () => {
  const place = (over: Partial<SessionPlace> = {}): SessionPlace =>
    ({ database: 'sales', transactionCount: 0, pinned: false, running: false, ...over })
  it('follows the sidebar from where it was', () => expect(followDecision(place(), 'sales')).toBe('follow'))
  it('stays in a database of its own', () => expect(followDecision(place({ database: 'master' }), 'sales')).toBe('stay'))
  it('stays in a transaction', () => expect(followDecision(place({ transactionCount: 1 }), 'sales')).toBe('stay'))
  it('stays pinned to a routine', () => expect(followDecision(place({ pinned: true }), 'sales')).toBe('stay'))
  it('follows later when its query is running', () => expect(followDecision(place({ running: true }), 'sales')).toBe('later'))
  it('stays, running or not, when a transaction was already open', () =>
    expect(followDecision(place({ running: true, transactionCount: 1 }), 'sales')).toBe('stay'))
})

describe('refuseAfterLoss', () => {
  it('refuses when a transaction was open', () => expect(refuseAfterLoss(state({ transactionCount: 1 }), 'sales')).toBe(true))
  it('refuses when the session was in another database', () => expect(refuseAfterLoss(state({ database: 'master' }), 'sales')).toBe(true))
  it('runs on when there was nothing to lose', () => expect(refuseAfterLoss(state(), 'SALES')).toBe(false))
})

describe('withTransactionSince', () => {
  const now = new Date('2026-10-21T10:00:00Z')
  it('notes when a transaction opens, and keeps that time while it stays open', () => {
    const opened = withTransactionSince(null, state({ transactionCount: 1, transactionState: 1 }), now)
    expect(opened.transactionSince).toBe('2026-10-21T10:00:00.000Z')
    const later = withTransactionSince(opened, state({ transactionCount: 2, transactionState: 1 }), new Date('2026-10-21T10:05:00Z'))
    expect(later.transactionSince).toBe('2026-10-21T10:00:00.000Z')
  })
  it('forgets it once the transaction is gone', () =>
    expect(withTransactionSince(state({ transactionCount: 1, transactionSince: 'x' }), state(), now).transactionSince).toBeUndefined())
})

describe('the words', () => {
  it('says what a lost session took with it', () => {
    expect(lostSessionNote(state())).toBe(
      "This tab's session was closed — temp tables and settings from earlier runs are gone.")
    expect(lostSessionNote(state({ transactionCount: 1 }))).toBe(
      "This tab's session was closed — temp tables and settings from earlier runs are gone, and its open transaction was rolled back by the server.")
  })
  it('says nothing ran, and where the next run starts', () =>
    expect(lostSessionRefusal(state({ transactionCount: 1 }), 'sales')).toBe(
      "This tab's session was closed — temp tables and settings from earlier runs are gone, and its open transaction was rolled back by the server. Nothing was run; run again to start a new session in sales."))
  it('gives a transaction its age', () => {
    const now = new Date('2026-10-21T11:05:30Z')
    expect(transactionAge('2026-10-21T11:05:18Z', now)).toBe('12s')
    expect(transactionAge('2026-10-21T11:01:30Z', now)).toBe('4m')
    expect(transactionAge('2026-10-21T10:00:30Z', now)).toBe('1h 5m')
    expect(transactionAge(undefined, now)).toBe('')
  })
  it('knows a transaction that can only be rolled back', () => {
    expect(transactionOpen(state({ transactionCount: 1, transactionState: 1 }))).toBe(true)
    expect(canCommit(state({ transactionCount: 1, transactionState: -1 }))).toBe(false)
    expect(canCommit(state({ transactionCount: 1, transactionState: 1 }))).toBe(true)
    expect(transactionOpen(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit test/unit/sessions.test.ts`
Expected: FAIL (`Cannot find module '../../src/shared/sessions'`).

- [ ] **Step 3: Add the types to `src/shared/types.ts`, and write `src/shared/sessions.ts`**

`followDecision` checks in this order: pinned, then an open transaction, then a different
database (`stay` for each); then running (`later`); otherwise `follow`. `sameDatabase` compares
lower-cased names. `lostSessionRefusal` is the note followed by
`Nothing was run; run again to start a new session in <db>.`

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run --project unit test/unit/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/sessions.ts test/unit/sessions.test.ts
git commit -m "Name what a query tab's session is, and the rules it follows"
```

---

### Task 2: A pool config that holds one connection and never replaces it

**Files:**
- Modify: `src/main/db/sqlserver/config.ts`
- Test: `test/unit/driver-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SESSION_IDLE_MS = 2_147_483_647
  export function buildSessionConfig(
    connection: ConnectionConfig,
    tunnel: TunnelEndpoint | null | undefined,
    database: string,
    beforeConnect: (connection: unknown) => void
  ): MssqlConfig
  ```

- [ ] **Step 1: Write the failing test** (use the file's existing `config()` fixture):

```ts
describe('buildSessionConfig', () => {
  it('holds one connection, never closes it for idling, and does not let the pool swap it', () => {
    const hook = () => undefined
    const built = buildSessionConfig(config(), { localHost: '127.0.0.1', localPort: 54321 }, 'reports', hook) as unknown as Record<string, any>
    expect(built.pool).toEqual({ min: 0, max: 1, idleTimeoutMillis: SESSION_IDLE_MS })
    expect(built.validateConnection).toBe(false)
    expect(built.beforeConnect).toBe(hook)
    expect(built.database).toBe('reports')
    expect(built.server).toBe('127.0.0.1')
    expect(built.port).toBe(54321)
    expect(built.options.encrypt).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run --project unit test/unit/driver-config.test.ts -t buildSessionConfig`
Expected: FAIL (`buildSessionConfig is not a function`).

- [ ] **Step 3: Implement `buildSessionConfig`** as `buildMssqlConfig({ ...connection, database }, tunnel)`,
with `pool`, `validateConnection` and `beforeConnect` set as the test says. Add a comment saying why:
mssql validates a pooled connection and swaps a dead one silently, which would run the next script
on a fresh session.

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run --project unit test/unit/driver-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/sqlserver/config.ts test/unit/driver-config.test.ts
git commit -m "Build the pool config for a session that must never be replaced"
```

---

### Task 3: `QuerySession`

**Files:**
- Create: `src/main/db/sqlserver/session.ts`
- Test: `test/integration/query-sessions.test.ts` (new file, which later tasks extend)

**Interfaces:**
- Consumes: `buildSessionConfig`, `SESSION_IDLE_MS` (Task 2); `STATE_SQL`, `ROLLBACK_SQL`,
  `withTransactionSince` (Task 1).
- Produces:
  ```ts
  export type SessionLostListener = (had: SessionState) => void
  export class QuerySession {
    readonly pinnedDatabase: string | undefined
    state: SessionState | null   // as last read
    lost: SessionState | null    // what it had, once lost; then it is never used again
    busy: boolean                // a run, a state read or a USE is in flight
    static open(connection: ConnectionConfig, tunnel: TunnelEndpoint | null, database: string,
                options: { pinnedDatabase?: string; onLost: SessionLostListener }): Promise<QuerySession>
    get pool(): sql.ConnectionPool                 // throws `This tab's session was closed.` once lost or closed
    readState(now?: Date): Promise<SessionState>   // runs STATE_SQL; a failure marks it lost and rethrows
    markLost(): void                               // idempotent; calls onLost once with `state` (or a zero state in `database`)
    close(): Promise<void>                         // unless lost: ROLLBACK_SQL, then pool.close(); never reports a loss
  }
  ```

The algorithm the tests cannot pin down (in `open`, through `beforeConnect`):

- **The probe connection:** mssql's `pool.connect()` makes one connection to try the settings and
  destroys it. Ignore every connection created before `connect()` resolves.
- **The session's connection:** the first connection created after that is the one. Keep it, and
  mark the session lost on its `'end'` unless `close()` is in progress.
- **A replacement:** any later creation is a swap. Mark the session lost and call `close()` on the
  new connection at once. Because mssql sets `propagateCreateError`, the request that wanted it
  fails without being sent.
- **Before returning:** `open()` calls `readState()`, so the connection exists and `state` is set.

- [ ] **Step 1: Write the failing tests.** Create the file with shared setup that later tasks
reuse:

```ts
let admin: SqlServerClient
const clients: SqlServerClient[] = []
const sessions: QuerySession[] = []

beforeAll(async () => {
  await createTestDatabase()
  admin = await connectedClient()
  const [seeded] = await admin.runScript(`
    IF OBJECT_ID('dbo.session_items') IS NOT NULL DROP TABLE dbo.session_items;
    CREATE TABLE dbo.session_items (id int PRIMARY KEY, name nvarchar(50));
    INSERT dbo.session_items VALUES (1, N'original'), (2, N'b');`)
  expect(seeded.error).toBeUndefined()
}, 180000)

afterAll(async () => {
  for (const session of sessions) await session.close().catch(() => undefined)
  for (const client of clients) await client.disconnect()
  await admin?.disconnect()
})

/** The first cell of the last result set, through the shared pool. */
async function scalar(client: SqlServerClient, text: string): Promise<unknown> { /* runScript; throw on error */ }
async function until(check: () => boolean, ms = 5000): Promise<void> { /* poll every 50 ms; throw on timeout */ }
async function openSession(onLost = (_: SessionState) => undefined, options: Partial<ConnectionConfig['options']> = {}): Promise<QuerySession> {
  const config = makeConfig({ options: { ...makeConfig().options, ...options } })
  const session = await QuerySession.open(config, null, TEST_DATABASE, { onLost })
  sessions.push(session)
  return session
}

describe('QuerySession', () => {
  it('keeps a temp table past the shared pool\'s idle timeout', async () => {
    const session = await openSession(undefined, { poolIdleTimeoutMs: 1000 })
    await session.pool.request().batch('CREATE TABLE #kept (id int)')
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const result = await session.pool.request().query('SELECT COUNT(*) AS n FROM #kept')
    expect(result.recordset[0].n).toBe(0)
  })

  it('reads its state, and when its transaction opened', async () => {
    const session = await openSession()
    expect(session.state).toEqual({ transactionCount: 0, transactionState: 0, database: TEST_DATABASE })
    await session.pool.request().batch('BEGIN TRAN')
    const open = await session.readState()
    expect(open).toMatchObject({ transactionCount: 1, transactionState: 1, database: TEST_DATABASE })
    expect(typeof open.transactionSince).toBe('string')
    await session.pool.request().batch('ROLLBACK')
    expect((await session.readState()).transactionSince).toBeUndefined()
  })

  it('rolls back what is open when it is closed', async () => {
    const session = await openSession()
    await session.pool.request().batch("BEGIN TRAN; UPDATE dbo.session_items SET name = N'changed' WHERE id = 1;")
    await session.close()
    expect(await scalar(admin, 'SELECT name FROM dbo.session_items WHERE id = 1')).toBe('original')
  })

  it('is lost, and never replaced, when the server kills it', async () => {
    const reported: SessionState[] = []
    const session = await openSession((had) => reported.push(had))
    await session.pool.request().batch('BEGIN TRAN')
    await session.readState()
    const spid = (await session.pool.request().query('SELECT @@SPID AS spid')).recordset[0].spid
    await admin.runScript(`KILL ${spid}`)
    await until(() => session.lost !== null)
    expect(reported).toHaveLength(1)
    expect(reported[0].transactionCount).toBe(1)
    expect(() => session.pool).toThrow("This tab's session was closed.")
  })
})
```

- [ ] **Step 2: Run them and see them fail** (with the test environment up: `scripts/test-env.sh up`)

Run: `npx vitest run --project integration test/integration/query-sessions.test.ts`
Expected: FAIL (`Cannot find module '../../src/main/db/sqlserver/session'`).

- [ ] **Step 3: Implement `QuerySession`** per the Interfaces block and the algorithm above.
`readState` maps the row to numbers and passes it through `withTransactionSince(this.state, …,
now)`. `close()` sets the closing flag first, so its own `'end'` is not reported as a loss.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run --project integration test/integration/query-sessions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/db/sqlserver/session.ts test/integration/query-sessions.test.ts
git commit -m "Hold a query tab's session on one connection that is never swapped"
```

---

### Task 4: The client runs a tab's scripts on its session

**Files:**
- Modify: `src/main/db/types.ts`, `src/main/db/sqlserver/client.ts`
- Test: `test/integration/query-sessions.test.ts`

**Interfaces:**
- Consumes: `QuerySession` (Task 3); `refuseAfterLoss`, `lostSessionRefusal` (Task 1);
  `SESSION_LOST`, `SessionState`, `SessionLoss` (Task 1).
- Produces, in `src/main/db/types.ts`:
  ```ts
  export interface SessionRun { statements: StatementResult[]; session: SessionState | null; lost?: SessionLoss }
  export interface SessionChange { sessionId: string; state: SessionState | null; lost?: SessionState }
  export type SessionChangeListener = (change: SessionChange) => void
  export interface SessionRunOptions extends ExecuteOptions { pinnedDatabase?: string }
  // DbClient gains:
  runInSession(sessionId: string, text: string, options?: SessionRunOptions): Promise<SessionRun>
  closeSession(sessionId: string): Promise<void>
  onSessionChange(listener: SessionChangeListener | null): void
  ```

The decisions inside `SqlServerClient`:

- **Executing:** `executeOne(text, params, options, session?: QuerySession)` runs on
  `session.pool` when given, otherwise on the shared pool. It counts shared-pool requests in
  flight in a new `sharedRequests` field. A transport failure on a session calls
  `session.markLost()`, then `checkSharedPool()`, which runs `SELECT 1` on the shared pool and
  calls `handleDrop` only if that fails too. On the shared pool it calls `noteTransportFailure`,
  as now.
- **The read-only refusal:** move it out of `runScript` into `refusalFor(text, options)`. Both
  `runScript` and `runInSession` use it before touching anything.
- **The window's database:** the `windowDatabase` getter is
  `this.serverInfo?.currentDatabase || this.config.database || ''`.
- **`runInSession` order:**
  1. Split the script and check read-only. A refusal returns `{ statements: [refusal], session:
     live?.state ?? null }`.
  2. If the session is lost, drop its record. When `refuseAfterLoss(had, pinnedDatabase ??
     windowDatabase)` holds, return the refusal: one `StatementResult` whose error is
     `{ message: lostSessionRefusal(…), code: SESSION_LOST }` and whose message lists the same
     words, with `session: null` and `lost: { had, refused: true }`. Otherwise carry
     `lost: { had, refused: false }` into this run.
  3. Open the session if there is none. `openSession` calls `requirePool()` first, so it fails with
     the same words when the connection is not open or is reconnecting. It then opens in
     `pinnedDatabase ?? windowDatabase` on `this.tunnelHandle`, with `onLost` emitting
     `{ sessionId, state: null, lost: had }`.
  4. Mark it busy, run the batches until the first error, then `readState()`. A failure there has
     already marked the session lost.
  5. Return `{ statements, session: session.lost ? null : session.state, lost }`.
- **`closeSession(id)`:** removes the record and awaits `close()`. Asking first is the window's
  job.

- [ ] **Step 1: Write the failing tests** in a new `describe('a tab\'s session', …)`. `tabClient(over)`
pushes a `connectedClient(over)` onto `clients`. `first(run)` returns the first cell of the last
result set of a `SessionRun`.

```ts
it('keeps a temp table from one run to the next, with shared reads between, past the idle timeout', async () => {
  const client = await tabClient({ options: { ...makeConfig().options, poolIdleTimeoutMs: 1000 } })
  expect((await client.runInSession('a', 'CREATE TABLE #t (id int)')).statements[0].error).toBeUndefined()
  await Promise.all([client.listObjects(), client.listRoutines(), client.getAutocompleteSchema(),
    client.fetchTableData({ connectionId: 'x', schema: 'dbo', table: 'session_items', offset: 0, limit: 10, sorts: [], filters: [], filterMode: 'builder' })])
  expect(first(await client.runInSession('a', 'SELECT COUNT(*) FROM #t'))).toBe(0)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  expect(first(await client.runInSession('a', 'SELECT COUNT(*) FROM #t'))).toBe(0)
})

it('keeps USE inside the session', async () => {
  const client = await tabClient()
  expect((await client.runInSession('a', 'USE master')).session?.database).toBe('master')
  const page = await client.fetchTableData({ connectionId: 'x', schema: 'dbo', table: 'session_items', offset: 0, limit: 10, sorts: [], filters: [], filterMode: 'builder' })
  expect(page.rows).toHaveLength(2)
  expect((await client.listObjects()).some((o) => o.name === 'session_items')).toBe(true)
})

it('keeps an open transaction inside the session, and closing it rolls it back', async () => {
  const client = await tabClient()
  const run = await client.runInSession('a', "BEGIN TRAN; UPDATE dbo.session_items SET name = N'changed' WHERE id = 1;")
  expect(run.session).toMatchObject({ transactionCount: 1, transactionState: 1 })
  const [blocked] = await client.runScript('SET LOCK_TIMEOUT 500; SELECT name FROM dbo.session_items WHERE id = 1;')
  expect(blocked.error?.message).toMatch(/lock request time out/i)
  await client.closeSession('a')
  expect(await scalar(client, 'SELECT name FROM dbo.session_items WHERE id = 1')).toBe('original')
})

it('reports the transaction a cancelled run left open', async () => {            // Review Focus
  const client = await tabClient()
  const running = client.runInSession('a', "BEGIN TRAN; WAITFOR DELAY '00:00:05';", { executionId: 'slow' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(client.cancel('slow')).toBe(true)
  expect((await running).session?.transactionCount).toBe(1)
})

it("opens in the window's database when the connection names none", async () => {  // Review Focus
  const client = await tabClient({ database: '' })
  expect((await client.runInSession('a', 'SELECT 1')).session?.database).toBe(client.info?.currentDatabase)
})

it('refuses a write on a read-only connection before the session is touched, and lets transactions through', async () => {  // Review Focus
  const client = await tabClient({ readOnly: true })
  expect((await client.runInSession('a', 'DELETE FROM dbo.session_items')).statements[0].error?.code).toBe(READ_ONLY_CONNECTION)
  expect((await client.runInSession('a', 'BEGIN TRAN; SELECT 1;')).session?.transactionCount).toBe(1)
  expect((await client.runInSession('a', COMMIT_SQL)).session?.transactionCount).toBe(0)
})

it('refuses the next run after losing a session that had a transaction open', async () => {
  const client = await tabClient()
  const changes: SessionChange[] = []
  client.onSessionChange((change) => changes.push(change))
  const spid = first(await client.runInSession('a', 'BEGIN TRAN; SELECT @@SPID;'))
  await admin.runScript(`KILL ${spid}`)
  await until(() => changes.some((c) => c.lost))
  const refused = await client.runInSession('a', 'SELECT 1')
  expect(refused.statements[0].error?.code).toBe(SESSION_LOST)
  expect(refused.lost).toMatchObject({ refused: true, had: { transactionCount: 1 } })
  expect(refused.session).toBeNull()
  const next = await client.runInSession('a', 'SELECT 1')
  expect(next.statements[0].error).toBeUndefined()
  expect(next.lost).toBeUndefined()
})

it('runs on a new session, saying so, after losing one that had nothing open', async () => {
  const client = await tabClient()
  const changes: SessionChange[] = []
  client.onSessionChange((change) => changes.push(change))
  const spid = first(await client.runInSession('a', 'SELECT @@SPID'))
  await admin.runScript(`KILL ${spid}`)
  await until(() => changes.some((c) => c.lost))
  const run = await client.runInSession('a', 'SELECT 1')
  expect(run.statements[0].error).toBeUndefined()
  expect(run.lost).toMatchObject({ refused: false, had: { transactionCount: 0 } })
})

it('loses only the session that was killed', async () => {
  const client = await tabClient()
  const states: string[] = []
  client.onStateChange((event) => states.push(event.state))
  const spid = first(await client.runInSession('a', 'SELECT @@SPID'))
  await client.runInSession('b', 'CREATE TABLE #b (id int)')
  await admin.runScript(`KILL ${spid}`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(first(await client.runInSession('b', 'SELECT COUNT(*) FROM #b'))).toBe(0)
  expect(await scalar(client, 'SELECT 1')).toBe(1)
  expect(states).toEqual([])
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project integration test/integration/query-sessions.test.ts -t "tab's session"`
Expected: FAIL (`client.runInSession is not a function`).

- [ ] **Step 3: Add the interface to `src/main/db/types.ts`, and implement it in `client.ts`** as
decided above.

- [ ] **Step 4: Run every integration suite and see them pass**

Run: `npm run test:integration`
Expected: PASS. The existing suites still run on the shared pool, unchanged.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`. Expected: no errors. Fakes that implement `DbClient` get the new
methods as no-ops if typecheck asks.

```bash
git add src/main/db/types.ts src/main/db/sqlserver/client.ts test/integration/query-sessions.test.ts
git commit -m "Run each query tab's scripts on a session of its own"
```

---

### Task 5: Switching database moves sessions; a routine's stays put

**Files:**
- Modify: `src/main/db/sqlserver/session.ts`, `src/main/db/sqlserver/client.ts`
- Test: `test/integration/query-sessions.test.ts`

**Interfaces:**
- Consumes: `followDecision` (Task 1); `QuerySession`, `runInSession` (Tasks 3–4).
- Produces:
  - `QuerySession.pendingFollow: { from: string; to: string } | null`.
  - `QuerySession.use(database: string): Promise<SessionState>`, which sends
    `USE ${quoteIdent(database)}` and then reads the state.

The decisions:

- **On a switch:** `useDatabase(database)` notes `from = windowDatabase` before switching. After
  the shared pool has switched (the existing code), it goes through every live session with
  `followDecision({ database: s.state.database, transactionCount: s.state.transactionCount,
  pinned: Boolean(s.pinnedDatabase), running: s.busy }, from)`:
  - `follow`: `use(database)`, then emit `{ sessionId, state }`;
  - `later`: set `pendingFollow`;
  - `stay`: nothing.
- **A failed `USE`:** the session stays where it was. It is not lost, and nothing is thrown at the
  sidebar.
- **After a run:** `runInSession` applies `pendingFollow` before returning. It decides again with
  `running: false`, and the returned state is the one after any `USE`.
- **A refused switch:** this throws before any session is touched, as it does today.

- [ ] **Step 1: Write the failing tests.** In `beforeAll`, also create the other databases with
`IF DB_ID(N'tv_sessions_other') IS NULL CREATE DATABASE tv_sessions_other;` and
`IF DB_ID(N'tv sessions]odd') IS NULL CREATE DATABASE [tv sessions]]odd];`.

```ts
describe('switching database', () => {
  it('moves a following session with the sidebar, and tells the window', async () => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    await client.runInSession('a', 'SELECT 1')
    await client.useDatabase('tv_sessions_other')
    expect(changes).toContainEqual(expect.objectContaining({ sessionId: 'a', state: expect.objectContaining({ database: 'tv_sessions_other' }) }))
    expect(first(await client.runInSession('a', 'SELECT DB_NAME()'))).toBe('tv_sessions_other')
  })

  it('leaves a session in its own database, or in a transaction, where it is', async () => {
    const client = await tabClient()
    await client.runInSession('own', 'USE master')
    await client.runInSession('txn', 'BEGIN TRAN')
    await client.useDatabase('tv_sessions_other')
    expect(first(await client.runInSession('own', 'SELECT DB_NAME()'))).toBe('master')
    expect(first(await client.runInSession('txn', 'SELECT DB_NAME()'))).toBe(TEST_DATABASE)
  })

  it("keeps a routine's tab in the routine's database", async () => {
    const client = await tabClient()
    await client.useDatabase('tv_sessions_other')
    expect(first(await client.runInSession('r', 'SELECT DB_NAME()', { pinnedDatabase: TEST_DATABASE }))).toBe(TEST_DATABASE)
    await client.useDatabase(TEST_DATABASE)
    await client.useDatabase('tv_sessions_other')
    expect(first(await client.runInSession('r', 'SELECT DB_NAME()', { pinnedDatabase: TEST_DATABASE }))).toBe(TEST_DATABASE)
  })

  it('follows once a running query ends', async () => {
    const client = await tabClient()
    await client.runInSession('d', 'SELECT 1')
    const running = client.runInSession('d', "WAITFOR DELAY '00:00:02'")
    await new Promise((resolve) => setTimeout(resolve, 300))
    await client.useDatabase('tv_sessions_other')
    expect((await running).session?.database).toBe('tv_sessions_other')
  })

  it('quotes a database name that needs it', async () => {                        // Review Focus
    const client = await tabClient()
    await client.runInSession('a', 'SELECT 1')
    await client.useDatabase('tv sessions]odd')
    expect(first(await client.runInSession('a', 'SELECT DB_NAME()'))).toBe('tv sessions]odd')
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project integration test/integration/query-sessions.test.ts -t "switching database"`
Expected: FAIL (the session is still in the old database).

- [ ] **Step 3: Implement `QuerySession.use`, `pendingFollow`, and the moves in `useDatabase` and
`runInSession`** as decided above.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run --project integration test/integration/query-sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/sqlserver/session.ts src/main/db/sqlserver/client.ts test/integration/query-sessions.test.ts
git commit -m "Move query tabs' sessions with the sidebar's database, but not a routine's"
```

---

### Task 6: Drops, disconnects and keepalive reach the sessions

**Files:**
- Modify: `src/main/db/sqlserver/session.ts`, `src/main/db/sqlserver/client.ts`
- Test: `test/integration/query-sessions.test.ts`

**Interfaces:**
- Produces:
  - `QuerySession.heartbeat(): Promise<void>`: `SELECT 1` unless busy or lost. A failure marks it
    lost.
  - `QuerySession.lastHeartbeatAt: number | null`: set when a heartbeat query actually ran.
  - `QuerySession.abandon(): Promise<void>`: closes the pool without sending anything (the socket
    is gone) and without reporting a loss.

The decisions:

- **A drop:** `handleDrop` marks every live session lost (each reports through `onLost`) and
  abandons it, before `teardown()`. The records stay, so the next run applies the rule from
  Task 4.
- **Disconnecting:** `disconnect()` awaits `close()` on every session and clears the map, with no
  events: the window is going.
- **Keepalive:** the existing interval also calls `heartbeatSessions()`, which runs `heartbeat()`
  on each live session that is not busy. `probe()` now skips only while `sharedRequests > 0`;
  today it skips while any request is running.

- [ ] **Step 1: Write the failing tests**

```ts
describe('drops, disconnects and keepalive', () => {
  it('reports every session lost when the connection drops, and holds them to the rule once it is back', async () => {
    const client = await tabClient()
    const changes: SessionChange[] = []
    client.onSessionChange((change) => changes.push(change))
    const back = new Promise<void>((resolve) => client.onStateChange((e) => e.state === 'connected' && resolve()))
    await client.runInSession('txn', 'BEGIN TRAN')
    await client.runInSession('plain', 'SELECT 1')
    // The drop the heartbeat would report, driven through the client's own handling.
    await (client as unknown as { handleDrop(error: unknown): Promise<void> }).handleDrop(new Error('socket hang up'))
    await back
    expect(changes.filter((c) => c.lost).map((c) => [c.sessionId, c.lost!.transactionCount]).sort()).toEqual([['plain', 0], ['txn', 1]])
    expect((await client.runInSession('txn', 'SELECT 1')).statements[0].error?.code).toBe(SESSION_LOST)
    expect((await client.runInSession('plain', 'SELECT 1')).lost?.refused).toBe(false)
  })

  it('closes every session on disconnect', async () => {
    const client = await tabClient({ options: { ...makeConfig().options, applicationName: 'tv-sessions-disconnect' } })
    await client.runInSession('a', 'SELECT 1')
    await client.runInSession('b', 'SELECT 1')
    await client.disconnect()
    expect(await scalar(admin, "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE program_name = 'tv-sessions-disconnect'")).toBe(0)
  })

  it('heartbeats an idle session, and leaves a busy one alone', async () => {
    const client = await tabClient({ options: { ...makeConfig().options, keepAliveIntervalMs: 200 } })
    await client.runInSession('a', 'SELECT 1')
    const session = (client as unknown as { sessions: Map<string, QuerySession> }).sessions.get('a')!
    await until(() => session.lastHeartbeatAt !== null, 2000)
    const running = client.runInSession('a', "WAITFOR DELAY '00:00:01.500'")
    await new Promise((resolve) => setTimeout(resolve, 300))
    const during = session.lastHeartbeatAt
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(session.lastHeartbeatAt).toBe(during)
    await running
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project integration test/integration/query-sessions.test.ts -t "drops, disconnects"`
Expected: FAIL.

- [ ] **Step 3: Implement `heartbeat`, `lastHeartbeatAt` and `abandon`; the drop, disconnect and
keepalive changes in `client.ts`**, as decided above.

- [ ] **Step 4: Run every integration suite and see them pass**

Run: `npm run test:integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/sqlserver/session.ts src/main/db/sqlserver/client.ts test/integration/query-sessions.test.ts
git commit -m "Report sessions lost on a drop, close them on disconnect, keep idle ones alive"
```

---

### Task 7: The registry, IPC and preload carry sessions to the window

**Files:**
- Modify: `src/main/db/registry.ts`, `src/shared/ipc.ts`, `src/main/ipc/index.ts`, `src/preload/index.ts`
- Test: `test/unit/registry-recovery.test.ts`

**Interfaces:**
- Consumes: `SessionChange`, `runInSession`, `closeSession`, `onSessionChange` (Task 4);
  `SessionEvent` (Task 1).
- Produces:
  - **Registry:** `ConnectionRegistry.onSessionChange(listener: (scope: string, connectionId:
    string, change: SessionChange) => void): () => void`.
  - **Channels:** `CHANNELS.queryCloseSession = 'query:closeSession'` and
    `CHANNELS.eventSessionChanged = 'event:sessionChanged'`.
  - **`RendererApi`:** `closeSession(connectionId: string, sessionId: string): Promise<void>` and
    `onSessionChanged(handler: (event: SessionEvent) => void): () => void`.
  - **`query:run`:** with `request.sessionId`, it calls
    `runInSession(request.sessionId, request.sql, { maxRows, executionId, asSingleBatch, onMessage,
    pinnedDatabase })` and returns `session: run.session ?? undefined` and
    `sessionLost: run.lost`. History records `run.session?.database ?? client.info?.currentDatabase`.
    Without `sessionId` it behaves as today.
  - **`query:closeSession`:** `registry.find(scope, connectionId)?.closeSession(sessionId)`, and a
    no-op when the connection is gone.
  - **Session events:** `registerIpcHandlers` subscribes to `registry.onSessionChange`, finds the
    scope's window as the status listener does, and sends `{ connectionId, ...change }` on
    `eventSessionChanged`.

- [ ] **Step 1: Write the failing tests.** Give `FakeClient` an `onSessionChange(listener)` that
stores it, and a `reportSession(change)` that calls it.

```ts
describe('a session that changes on its own', () => {
  it('reaches the window that owns it', async () => {
    const { registry, client } = await openOne()
    const seen: [string, string, SessionChange][] = []
    registry.onSessionChange((scope, connectionId, change) => seen.push([scope, connectionId, change]))
    const change = { sessionId: 'tab-3', state: null, lost: { transactionCount: 1, transactionState: 1 as const, database: 'sales' } }
    client.reportSession(change)
    expect(seen).toEqual([['win1', 'c1', change]])
  })

  it('is not heard from a client that has been closed', async () => {
    const { registry, client } = await openOne()
    const seen: unknown[] = []
    registry.onSessionChange((...args) => seen.push(args))
    await registry.close('win1', 'c1')
    client.reportSession({ sessionId: 'tab-3', state: null })
    expect(seen).toEqual([])
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit test/unit/registry-recovery.test.ts`
Expected: FAIL (`registry.onSessionChange is not a function`).

- [ ] **Step 3: Implement the registry routing** (subscribe in `open()` beside `onStateChange`;
`onSessionChange(null)` in `close` / `closeKey`). **Then implement the channels, the `RendererApi`
entries, the IPC handlers and the preload bindings** as listed.

- [ ] **Step 4: Run the unit tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/registry.ts src/shared/ipc.ts src/main/ipc/index.ts src/preload/index.ts test/unit/registry-recovery.test.ts
git commit -m "Carry query tabs' sessions over IPC, and their changes to the window"
```

---

### Task 8: Tabs know their session

**Files:**
- Create: `src/renderer/src/lib/tabSessions.ts`
- Modify: `src/renderer/src/stores/tabs.ts`, `src/renderer/src/lib/runQueryTab.ts`, `src/renderer/src/App.vue`
- Test: `test/unit/renderer/run-query-tab.test.ts`, `test/unit/renderer/tabs-store.test.ts`

**Interfaces:**
- Consumes: `closeSession`, `onSessionChanged`, and the `session` / `sessionLost` result fields
  (Task 7); `SessionEvent`, `SessionState` (Task 1).
- Produces:
  - `QueryTab.session?: SessionState`: as last reported; absent before the first run, and once
    lost or closed.
  - `QueryTab.sessionLost?: SessionState`: what a lost session had. Shown once; cleared when the
    next run starts.
  - `useTabStore().applySessionEvent(event: SessionEvent): void`.
  - In `lib/tabSessions.ts` (imports only `api` and types, so there is no import cycle with the
    store):
    ```ts
    export const STOP_WAIT_MS = 10_000
    export function endSession(tab: Pick<QueryTab, 'connectionId' | 'id'>): Promise<void>   // api.closeSession, errors swallowed
    export function stopRun(tab: Pick<QueryTab, 'connectionId' | 'executionId'>, isRunning: () => boolean, waitMs?: number): Promise<boolean>
    ```
    `stopRun` calls `api.cancelQuery`, then polls `isRunning` every 50 ms. It returns true once the
    run has stopped, or false after `waitMs`.

The decisions:

- **`runQueryTab`:** sends `sessionId: tab.id` and `pinnedDatabase: tab.routine?.database`. It
  sets `sessionLost: undefined` with `running: true`, and after the run stores
  `session: result.session` and `sessionLost: result.sessionLost?.had`.
- **`applySessionEvent`:** applies only to the query tab with that id and connection. `state`
  sets `session`. `lost` clears `session` and sets `sessionLost`.
- **`copyOf`:** a query tab's copy gets `session: undefined, sessionLost: undefined`.
- **`removeTab`:** calls `void endSession(tab)` for a query tab that has a `session`.
- **`App.vue`:** subscribes to `api.onSessionChanged(tabs.applySessionEvent)` in `onMounted` and
  unsubscribes on unmount, like the other subscriptions.

- [ ] **Step 1: Write the failing tests.** In `run-query-tab.test.ts`:

```ts
it("runs on the tab's own session, pinned to a routine's database", async () => {
  const tabs = useTabStore()
  await tabs.openRoutine('c1', { schema: 'dbo', name: 'usp_orders', baseline: STORED, database: 'sales' })
  runQuery.mockResolvedValue(answer())
  await runQueryTab(tabs.activeId!)
  expect(runQuery.mock.calls[0][0]).toMatchObject({ sessionId: tabs.activeId, pinnedDatabase: 'sales' })
})

it('keeps what the session said, and what a lost one had', async () => {
  const { tabs, id } = await routineTab()
  const session = { transactionCount: 1, transactionState: 1 as const, database: 'sales', transactionSince: 'x' }
  runQuery.mockResolvedValue({ ...answer(), session })
  await runQueryTab(id)
  expect(tab(tabs, id).session).toEqual(session)
  const had = { transactionCount: 1, transactionState: 1 as const, database: 'sales' }
  runQuery.mockResolvedValue({ ...answer({ error: 'closed' }), sessionLost: { had, refused: true } })
  await runQueryTab(id)
  expect(tab(tabs, id).session).toBeUndefined()
  expect(tab(tabs, id).sessionLost).toEqual(had)
})

it('clears an old loss when the next run starts', async () => {
  const { tabs, id } = await routineTab()
  tabs.update<QueryTab>(id, { sessionLost: { transactionCount: 0, transactionState: 0, database: 'sales' } })
  let during: unknown = 'unset'
  runQuery.mockImplementation(async () => { during = tab(tabs, id).sessionLost; return answer() })
  await runQueryTab(id)
  expect(during).toBeUndefined()
})
```

And in `tabs-store.test.ts`, mocking `lib/tabSessions` for the whole file
(`endSession: vi.fn(async () => {})`, `stopRun: vi.fn(async () => true)`):

```ts
describe("a query tab's session", () => {
  const live = { transactionCount: 1, transactionState: 1 as const, database: 'sales' }

  it('takes a change meant for it, and nobody else\'s', async () => {
    const tabs = useTabStore()
    await tabs.openQuery('c1')
    const id = tabs.activeId!
    tabs.applySessionEvent({ connectionId: 'c1', sessionId: id, state: live })
    expect((tabs.tabs[0] as QueryTab).session).toEqual(live)
    tabs.applySessionEvent({ connectionId: 'c2', sessionId: id, state: null, lost: live })
    expect((tabs.tabs[0] as QueryTab).session).toEqual(live)
    tabs.applySessionEvent({ connectionId: 'c1', sessionId: id, state: null, lost: live })
    expect((tabs.tabs[0] as QueryTab)).toMatchObject({ session: undefined, sessionLost: live })
  })

  it('does not carry a session into a split copy', async () => {                     // Review Focus
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    tabs.update<QueryTab>(tabs.activeId!, { session: live, sessionLost: live })
    await tabs.splitTab(tabs.activeId!)
    const copy = tabs.tabs[1] as QueryTab
    expect(copy.session).toBeUndefined()
    expect(copy.sessionLost).toBeUndefined()
  })

  it('does not save a session with the tab', async () => {
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    tabs.update<QueryTab>(tabs.activeId!, { session: live })
    expect(JSON.stringify(tabs.snapshot('c1'))).not.toContain('transactionCount')
  })

  it('ends the session of a tab that closes', async () => {
    const tabs = useTabStore()
    await tabs.openQuery('c1', 'SELECT 1')
    const id = tabs.activeId!
    tabs.update<QueryTab>(id, { session: { ...live, transactionCount: 0, transactionState: 0 } })
    await tabs.close(id)
    expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ id, connectionId: 'c1' }))
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit test/unit/renderer/run-query-tab.test.ts test/unit/renderer/tabs-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement it** as decided above.

- [ ] **Step 4: Run the unit tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/tabSessions.ts src/renderer/src/stores/tabs.ts src/renderer/src/lib/runQueryTab.ts src/renderer/src/App.vue test/unit/renderer/run-query-tab.test.ts test/unit/renderer/tabs-store.test.ts
git commit -m "Keep each query tab's session state on the tab"
```

---

### Task 9: Asking before a transaction is ended

**Files:**
- Create: `src/renderer/src/components/OpenTransactionDialog.vue`
- Modify: `src/renderer/src/stores/tabs.ts`, `src/renderer/src/views/WorkspaceView.vue`
- Test: `test/unit/renderer/tabs-store.test.ts`

**Interfaces:**
- Consumes: `stopRun`, `endSession` (Task 8); `transactionOpen`, `COMMIT_SQL`, `ROLLBACK_SQL`
  (Task 1); `runQueryTab`.
- Produces, in `stores/tabs.ts`:
  ```ts
  export type TransactionReason = CloseReason | 'move'
  export interface TransactionPrompt {
    tabId: string; reason: TransactionReason
    running: boolean   // its query is running inside a transaction that was already open
    stopped: boolean   // its query was stopped to close it, and left a transaction open
    resolve: (proceed: boolean) => void
  }
  // store returns: transactionPrompt (ref), answerTransaction(proceed: boolean): void
  ```

The algorithm, as an internal `canEndSessions(ids, reason)`. It asks one question at a time and
returns false if a prompt is already waiting.

```
for each id: tab = byId(id); skip unless a query tab
  if tab.running:
    if transactionOpen(tab.session):                    // open before this run
      ask({ running: true, stopped: false }) — false → return false; continue
    if !(await stopRun(tab, () => byId(id)?.running === true)): continue   // not stopped in 10 s: close anyway
    if transactionOpen(byId(id)?.session): ask({ running: false, stopped: true }) — false → return false
  else if transactionOpen(tab.session): ask({ running: false, stopped: false }) — false → return false
return true
```

While it waits on `stopRun`, the window shows that it is stopping a query. It puts up a toast,
*Stopping the query in {tab title}…* (`useToastStore().info`), and holds the busy bar
(`useBusyStore().begin()`, then `end()` once `stopRun` returns).

Where it is called:

- **`close(id, { moving })`:** calls it last, with reason `moving ? 'move' : 'close'`.
- **`canDiscard(ids, reason)`:** calls it after `canClose`, so Close others, Close all,
  disconnecting, closing the window and quitting all ask.
- **`hasUnsavedWork`:** also counts a query tab that is `running` or has `transactionOpen(session)`.

The dialog's copy, keyed by reason:

- **Causes:** `close` → *Closing the tab* / *close*; `move` → *Moving the tab to another window* /
  *move*; `disconnect` → *Disconnecting* / *disconnect*; `close-window` → *Closing the window* /
  *close*; `quit` → *Quitting* / *quit*.
- **Header:** kicker *Open transaction*. The title is *This tab has a transaction open*, or *This
  tab's query is running inside a transaction* when `running`. The subtitle is the tab's title and
  its session's database.
- **Text:** *{Its query was stopped part-way. }{Cause} would end the session, and with it the
  transaction.* When `running`, it adds *Its query has to stop first: nothing can be committed
  while it runs.*
- **Footer:** **Cancel** (focused on mount), then either **Stop and roll back** (`btn--danger`)
  when `running`, or **Roll back and {verb}** (`btn--danger`) and **Commit and {verb}**
  (`btn--primary`).
- **Actions:**
  - Commit runs `runQueryTab(id, COMMIT_SQL)` and answers true only if the run had no error and no
    transaction is open afterwards. Otherwise it answers false and selects the tab.
  - Roll back runs `runQueryTab(id, ROLLBACK_SQL)` and answers true.
  - Stop and roll back runs `stopRun`, then the rollback, and answers true.
  - The dialog answers false if its tab goes away, or if it unmounts unanswered, as
    `UnsavedRoutineDialog` does.

- [ ] **Step 1: Write the failing tests.** `asked(tabs)` polls for `tabs.transactionPrompt` as the
file's `asked` does for `closePrompt`.

```ts
describe('ending a session with a transaction open', () => {
  const open = { transactionCount: 1, transactionState: 1 as const, database: 'sales' }
  const none = { transactionCount: 0, transactionState: 0 as const, database: 'sales' }
  async function queryTab(tabs = useTabStore(), session = open) {
    await tabs.openQuery('c1', 'SELECT 1')
    const id = tabs.activeId!
    tabs.update<QueryTab>(id, { session })
    return { tabs, id }
  }

  it('closes without asking when no transaction is open and nothing runs', async () => {
    const { tabs, id } = await queryTab(undefined, none)
    expect(await tabs.close(id)).toBe(true)
    expect(tabs.transactionPrompt).toBeNull()
  })

  it('asks before closing a tab with a transaction open, and keeps it on Cancel', async () => {
    const { tabs, id } = await queryTab()
    const closing = tabs.close(id)
    expect(await asked(tabs)).toMatchObject({ tabId: id, reason: 'close', running: false, stopped: false })
    tabs.answerTransaction(false)
    expect(await closing).toBe(false)
    expect(tabs.tabs.map((t) => t.id)).toEqual([id])
  })

  it('asks before a tab with a transaction open moves to another window', async () => {
    const { tabs, id } = await queryTab()
    const moving = tabs.close(id, { moving: true })
    expect((await asked(tabs))?.reason).toBe('move')
    tabs.answerTransaction(true)
    expect(await moving).toBe(true)
  })

  it('asks before disconnecting, and before the window closes', async () => {
    const { tabs } = await queryTab()
    const disconnecting = tabs.closeConnection('c1')
    expect((await asked(tabs))?.reason).toBe('disconnect')
    tabs.answerTransaction(false)
    expect(await disconnecting).toBe(false)
    const quitting = tabs.canCloseWindow('quit')
    expect((await asked(tabs))?.reason).toBe('quit')
    tabs.answerTransaction(true)
    expect(await quitting).toBe(true)
  })

  it('stops a running query first, and asks only if that left a transaction open', async () => {
    const { tabs, id } = await queryTab(undefined, none)
    tabs.update<QueryTab>(id, { running: true, executionId: 'e1' })
    vi.mocked(stopRun).mockImplementationOnce(async () => { tabs.update<QueryTab>(id, { running: false }); return true })
    expect(await tabs.close(id)).toBe(true)
    expect(stopRun).toHaveBeenCalled()

    const second = await queryTab(tabs, none)
    tabs.update<QueryTab>(second.id, { running: true, executionId: 'e2' })
    vi.mocked(stopRun).mockImplementationOnce(async () => { tabs.update<QueryTab>(second.id, { running: false, session: open }); return true })
    const closing = tabs.close(second.id)
    expect(await asked(tabs)).toMatchObject({ stopped: true, running: false })
    tabs.answerTransaction(true)
    expect(await closing).toBe(true)
  })

  it('asks before stopping a query that runs inside an open transaction', async () => {
    const { tabs, id } = await queryTab()
    tabs.update<QueryTab>(id, { running: true, executionId: 'e1' })
    vi.mocked(stopRun).mockClear()
    const closing = tabs.close(id)
    expect(await asked(tabs)).toMatchObject({ running: true })
    expect(stopRun).not.toHaveBeenCalled()
    tabs.answerTransaction(false)
    expect(await closing).toBe(false)
  })

  it('closes anyway when a query does not stop in time', async () => {
    const { tabs, id } = await queryTab(undefined, none)
    tabs.update<QueryTab>(id, { running: true, executionId: 'e1' })
    vi.mocked(stopRun).mockResolvedValueOnce(false)
    expect(await tabs.close(id)).toBe(true)
    expect(tabs.transactionPrompt).toBeNull()
  })

  it('counts a running query or an open transaction as work the window would lose', async () => {
    const { tabs, id } = await queryTab(undefined, none)
    expect(tabs.hasUnsavedWork).toBe(false)
    tabs.update<QueryTab>(id, { session: open })
    expect(tabs.hasUnsavedWork).toBe(true)
    tabs.update<QueryTab>(id, { session: none, running: true })
    expect(tabs.hasUnsavedWork).toBe(true)
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit test/unit/renderer/tabs-store.test.ts -t "transaction open"`
Expected: FAIL.

- [ ] **Step 3: Implement `canEndSessions`, `transactionPrompt` and `answerTransaction`, and the
calls from `close` and `canDiscard`.** Extend `hasUnsavedWork`. Write
`OpenTransactionDialog.vue` on `BaseModal`, with the copy and actions above and the prompt styles
of `UnsavedRoutineDialog.vue`. Mount it in `WorkspaceView.vue` beside that dialog:
`<OpenTransactionDialog v-if="tabs.transactionPrompt" />`.

- [ ] **Step 4: Run the unit tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. The existing close-prompt tests still pass: none of their tabs has a session.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/tabs.ts src/renderer/src/components/OpenTransactionDialog.vue src/renderer/src/views/WorkspaceView.vue test/unit/renderer/tabs-store.test.ts
git commit -m "Ask before a query tab's open transaction would be ended"
```

---

### Task 10: Showing the session, and the end-to-end check

**Files:**
- Modify: `src/renderer/src/views/QueryView.vue`, `src/renderer/src/components/TabBar.vue`, `src/renderer/src/components/StatusBar.vue`
- Test: `test/e2e/unsaved.mjs`

**Interfaces:**
- Consumes: `transactionOpen`, `canCommit`, `transactionAge`, `lostSessionNote`, `sameDatabase`,
  `COMMIT_SQL`, `ROLLBACK_SQL` (Task 1); `QueryTab.session` / `sessionLost` (Task 8);
  `runQueryTab`.
- Produces (read by the e2e test and the docs):
  - **Database badge, `.query__database`:** a `.badge` with the `database` icon, showing
    `tab.session?.database ?? tab.routine?.database` whenever that differs (by `sameDatabase`)
    from `connections.activeStatus?.currentDatabase`.
  - **Transaction badge, `.query__transaction`:** `clock` icon and
    `Transaction open · {transactionAge(since, now)}`, coloured with `--warning`. `now` ticks once a
    second only while a transaction is open, and the timer is cleared on unmount. Beside it are
    the **Commit** and **Rollback** buttons (`.btn`), which run `runQueryTab(tab.id, COMMIT_SQL /
    ROLLBACK_SQL)`. Both are disabled while `tab.running`. Commit is also disabled when
    `!canCommit(tab.session)`, with the title *An error has doomed this transaction: it can only be
    rolled back*.
  - **Lost-session notice, `.query__notice`:** above the results when `tab.sessionLost` is set,
    with the `info` icon and `lostSessionNote(tab.sessionLost)`.
  - **Tab mark, `.tab__txn`:** a `clock` icon, `title="Transaction open"`, on a query tab with
    `transactionOpen(tab.session)`. It is shown regardless of the spinner or the dot.
  - **Status-bar count, `.status__txn`:** while any tab has one open, `{n} open transaction` or
    `{n} open transactions`, with the `clock` icon.

- [ ] **Step 1: Write the failing e2e section** in `test/e2e/unsaved.mjs`, between section 1 and
section 2. The fresh profile's one blank query tab is showing.

```js
// --- 1b. a query tab keeps its session, and asks before ending a transaction --
const typeAndRun = async (sql) => {
  await ev(`document.querySelector('.cm-content').focus()`)
  await key('a', 'KeyA', 65, 2)                                  // Ctrl+A: replace what is there
  await send('Input.insertText', { text: sql })
  await ev(`document.querySelector('.query__toolbar .btn--primary').click()`)
  await waitFor(`!document.querySelector('.tab .tab__spinner')`, 'the run to end')
}
await typeAndRun('CREATE TABLE #e2e_session (id int);')
await typeAndRun('SELECT COUNT(*) AS n FROM #e2e_session;')
await waitFor(`document.querySelector('.results__body .grid__row .grid__cell')?.textContent.trim() === '0'`, 'the temp table, still there on the next run')
await typeAndRun('BEGIN TRAN; SELECT 1 AS one;')
await waitFor(`document.querySelector('.query__transaction')?.textContent.includes('Transaction open')`, 'the transaction badge')
check(await ev(`!!document.querySelector('.tab__txn')`), 'the tab does not carry the transaction mark')
check((await ev(`document.querySelector('.status__txn')?.textContent ?? ''`)).includes('1 open transaction'), 'the status bar does not count it')
await shot('00-transaction-open')
await ev(`document.querySelector('.tab .tab__close').click()`)
await promptFor('This tab has a transaction open')
steps.push({ step: 'close tab: transaction', ...(await modal()) })
check(['Cancel', 'Roll back and close', 'Commit and close'].every((b) => steps.at(-1).buttons.includes(b)), 'the prompt does not offer what it should')
await press('Cancel')
await promptGone()
check(await ev(`!!document.querySelector('.query__transaction')`), 'Cancel ended the transaction')
await ev(`document.querySelector('.tab .tab__close').click()`)
await promptFor('This tab has a transaction open')
await press('Roll back and close')
await promptGone()
check(!(await ev(`!!document.querySelector('.status__txn')`)), 'the transaction is still counted after it was rolled back')
```

- [ ] **Step 2: Run it and see it fail**

Run: `scripts/test-env.sh up && scripts/e2e.sh unsaved`
Expected: `UNSAVED E2E FAIL: timed out waiting for the transaction badge`.

- [ ] **Step 3: Implement the badge, buttons, notice, tab mark and status count** as listed.

- [ ] **Step 4: Run the checks**

Run: `npm run typecheck && npm test && scripts/e2e.sh unsaved && scripts/e2e.sh routines && scripts/e2e.sh read-only`
Expected: PASS for all three suites.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/views/QueryView.vue src/renderer/src/components/TabBar.vue src/renderer/src/components/StatusBar.vue test/e2e/unsaved.mjs
git commit -m "Show a query tab's database and open transaction, and test it end to end"
```

---

### Task 11: Docs, changelog and version

**Files:**
- Modify: `docs/query-editor.md`, `docs/read-only.md`, `docs/architecture.md`, `README.md`,
  `CLAUDE.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: `docs/query-editor.md`:** add a section *Each tab has a session of its own*, in
the docs' prose. It covers:
  - what carries over between runs;
  - the database rule, including routine tabs;
  - the transaction badge, Commit and Rollback;
  - the questions before closing, moving, disconnecting or quitting, and what happens to a
    running query;
  - that a tab moved to another window starts a new session there, so its temp tables and
    settings stay behind;
  - lost sessions and the refused run;
  - a table tab waiting on a lock that a tab's transaction holds.
- [ ] **Step 2: `docs/read-only.md`:** say that `USE` changes the database of the tab it ran in,
  and nothing else.
- [ ] **Step 3: `docs/architecture.md`:**
  - add `session.ts`, `shared/sessions.ts`, `lib/tabSessions.ts` and `OpenTransactionDialog` to
    the source layout;
  - add a decision paragraph: **A query tab has a session of its own; everything else shares the
    pool.** It says why: the pool hands connections back last-in, first-out, never resets them, and
    closes idle ones. It also says why a session's connection is never replaced.
- [ ] **Step 4: `CLAUDE.md` and `README.md`:**
  - in `CLAUDE.md`, add an invariant line: query tabs run on `QuerySession`s, and the shared pool
    is for the app's own reads;
  - in the README's *Queries* list, add one bullet: each tab keeps its own session, as an SSMS
    window does, and an open transaction is shown and asked about.
- [ ] **Step 5: Version and changelog.** Run `git fetch --tags`. `package.json` should equal the
  newest tag, `0.2.1`. Then run `npm version minor --no-git-tag-version`, which gives 0.3.0. Add
  `## 0.3.0` at the top of `CHANGELOG.md`, with bullets in plain words for someone using the app:
  - temp tables, `SET` and `USE` carry between runs and stay in their tab;
  - an open transaction is shown, can be committed or rolled back, and is asked about before it is
    ended;
  - a `USE` in a query tab no longer breaks table tabs and the schema tree;
  - a procedure's tab saves into the procedure's own database after a sidebar switch.
- [ ] **Step 6: Final checks**

Run: `npm run typecheck && npm test && npm run test:integration`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/query-editor.md docs/read-only.md docs/architecture.md README.md CLAUDE.md CHANGELOG.md package.json package-lock.json
git commit -m "Document query tabs' sessions; 0.3.0"
```
