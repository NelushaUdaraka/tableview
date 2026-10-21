# Query tabs with sessions of their own

**Date:** 2026-10-21
**Status:** design agreed in conversation; reviewed; waiting on the user's read-through before a
plan is written
**Issue:** [#31](https://github.com/NelushaUdaraka/tableview/issues/31)

## Why

A query tab has no database session of its own. Every run, and every `GO` batch in a run, borrows
whichever connection is free from the pool the whole window shares (`executeOne` → `pool.request()`
in `src/main/db/sqlserver/client.ts`). That pool:

- hands back the most recently released connection, because tarn keeps its free list last-in,
  first-out;
- never resets a connection between uses;
- closes any connection that has been idle for 30 seconds (`poolIdleTimeoutMs` in
  `DEFAULT_SQLSERVER_OPTIONS`, `src/shared/types.ts`).

I reproduced the following with `SqlServerClient` and default options against the SQL Server 2022
test container:

| What the user does | What happens today |
| --- | --- |
| `CREATE TABLE #t …`, `GO`, `SELECT … FROM #t` in one run | Works: the same connection is reused |
| Make `#t2` in one run; the window reads several things at once (as a schema refresh does); select from `#t2` in the next run | `Invalid object name '#t2'` |
| Make `#t3` in one run; run again 35 s later | `Invalid object name '#t3'`: the pool closed the idle connection |
| `USE master` in a query tab, then read a table tab in the same window | `Invalid object name 'dbo.items'`, and the schema tree lists nothing because it read `master` |
| `BEGIN TRAN; UPDATE …` left open | Another session's read of the row times out on its lock. The window's own table tab shows the change as if saved. 35 s later the pool closes the connection and SQL Server rolls the change back without a word, so a later `COMMIT` fails |

Nothing a query sets up reliably survives to the next run, and two things leak out of the tab
that set them:

- **`USE`:** it sends the window's table tabs and schema tree to another database.
- **An open transaction:** it becomes part of whatever borrows its connection next. That lasts
  until the pool closes the connection and SQL Server rolls the work back.

The user mostly works on read-only connections while trying TableView out, and has made no risky
changes with it yet. For them, the leak of `USE` is the part that bites today, because read-only
allows `USE`. Transactions matter once they start writing. The design still has to be safe for
transactions from the start, because a tab session that lasts makes an open transaction last too.

## Goals

- **A session per tab:** each query tab runs on a session of its own, held from its first run
  until the tab closes. `USE`, `SET` options, temp tables and transactions carry from one run to
  the next in that tab, as they do in an SSMS query window.
- **Nothing leaks:** nothing a query tab does on its session reaches anything else: other query
  tabs, table tabs, the schema tree, completion or the keepalive. Those keep using the shared
  pool.
- **Transactions are visible:** an open transaction always shows on its tab, and can be committed
  or rolled back with a button. It is never ended without asking: not by closing the tab,
  disconnecting, quitting, or moving the tab to another window.
- **Lost sessions are reported:** a session that is lost, because the connection dropped or the
  server closed it, is reported on its tab. The tab is never quietly handed a fresh session as if
  nothing happened, and a run that relied on what was lost is not sent.
- **Database switching:** switching database from the sidebar moves the tabs along, except tabs
  that chose a database of their own or are in a transaction (see *Switching database from the
  sidebar* below).

## Non-goals

- **Lock waits:** telling a table tab why it is waiting on a lock. A table tab that reads rows a
  query tab's open transaction has changed waits for that transaction, as it would in SSMS. The
  exception is a database using read-committed snapshot, where it reads the last committed row
  instead. The transaction's marker on its tab is how the user finds the cause.
- **Execution plans** (#36), which this change makes possible.
- **Temp tables on read-only connections.** The read-only check refuses them (`docs/read-only.md`),
  and that stays as it is. It deserves its own issue once tabs keep their sessions.
- **A database picker on each query tab**, like SSMS's toolbar drop-down. A tab's database comes
  from the sidebar or from its own `USE`.
- **Completion for a tab in another database.** Completion keeps reading the sidebar's database,
  even for a tab that has moved elsewhere.
- **Carrying a session across windows or a restart.** Tabs reopened from `ui-state.json` start
  without one.

## Anti-goals (a failure even if it works)

- **Ending a transaction unasked:** a transaction committed or rolled back without the user
  pressing the button, or answering a question that said so. The one exception is a session the
  server or the network ends, and that is reported.
- **Leaks:** anything a query tab sets up (`USE`, `SET`, a temp table, a transaction) reaching
  another tab, a table tab, the schema tree or completion.
- **New questions for people who never use transactions:** closing, disconnecting, quitting and
  moving tabs ask nothing new unless a transaction is open.
- **Slower or broken browsing:** table browsing, the schema tree or completion getting slower, or
  failing, because of this change.
- **Silent replacement:** a tab that lost its session carrying on as if it had not.

## Constraints

- **Repository invariants** (`CLAUDE.md`):
  - `src/main/db/**` never imports Electron.
  - Read-only is enforced in the main process: a script for a tab's session goes through the same
    `findWriteInScript` check before anything is sent.
  - Values are bound, and identifiers go through `src/shared/sql/identifiers.ts`. A `USE` the app
    sends itself quotes the name with `quoteIdent`.
  - Scripts split on `GO`.
  - An IPC addition touches `shared/ipc.ts`, `main/ipc/index.ts`, `preload/index.ts` and
    `renderer/src/lib/api.ts`.
- **Tunnels:** it must behave the same through an SSH tunnel and an AWS SSM forward. Sessions
  connect to the same local port the pool does; the pool already opens several connections
  through it.
- **Reconnects:** it must fit the reconnect logic in `client.ts` and `reconnect.ts`. A drop takes
  the pool and every session down. The pool comes back on its own; a session comes back only when
  its tab next runs.
- **UI:** follows `design-system/tableview/MASTER.md` and the tokens in
  `src/renderer/src/styles/index.css`, with icons from `lib/icons.ts`. Class names and button text
  that `test/e2e/*.mjs` reads stay as they are.
- **One connection per window:** this and the per-window registry scopes stay as they are. A
  session belongs to its window's client.

## What the user decided

- **Order:** build #31 before the other suggestions (#32–#42).
- **Played back and confirmed** (asked what was wrong or missing, they answered "nothing"):
  - **Sessions:** each query tab gets its own connection the first time it runs something, kept
    until the tab closes. What is set in a tab (`USE`, `SET` options, temp tables, transactions)
    stays in that tab from one run to the next, and reaches neither other tabs, the table tabs
    nor the sidebar.
  - **Database switching:** a new tab starts in the sidebar's database. Switching the sidebar's
    database moves the tabs along with it, except a tab that has run its own `USE` or has a
    transaction open. That tab stays where it is and shows which database it is in.
  - **Transactions:** today an open transaction quietly disappears after 30 seconds. With a
    session per tab it would stay open, blocking others, until committed, rolled back or the tab
    is closed. So three things are part of this change, not later:
    - an "open transaction" marker on the tab, with Commit and Rollback;
    - a question before the tab, the window or the app closes while a transaction is open;
    - the same question before the tab is dragged into another window.
  - **Not in this change:** explaining to a table tab why it is waiting on a lock; execution
    plans; temp tables on read-only connections.

## How it behaves

### A tab and its session

- **Opening:** a tab has no session until it first runs something: Run, Run selection, Run
  statement, or a routine's *Save and close*. The first run opens it, so a tab that is only ever
  looked at costs nothing. Tabs reopened after a connect or a restart start the same way.
- **Where it connects:** the session opens in the window's current database, the one the sidebar
  shows. The exception is a routine's tab, which opens in the routine's own database
  (`routine.database`; see the database rule below). It connects the way the pool does: the same
  login, options and tunnel endpoint.
- **Runs:** every run in the tab, and every `GO` batch in it, goes to that session, one at a time.
  The read-only check runs on the script before it reaches the session, exactly as now.
- **Closing:** the session closes when the tab closes, when the window disconnects or closes, and
  when the app quits, after any question below.

### What the tab knows about its session

After every run, whether it succeeded, failed or was cancelled, the app reads the session's state on
the same session: `@@TRANCOUNT`, `XACT_STATE()` and `DB_NAME()`. It may also read `@@SPID` to show
which server session the tab is, but never to tell two sessions apart, because SQL Server reuses
SPIDs. This state drives everything the tab shows:

- **Database:** when the session's database differs from the sidebar's, the query toolbar shows
  it. A tab that ran `USE master` says `master`. When they match, nothing is shown.
- **Open transaction:** when `@@TRANCOUNT > 0`:
  - the tab's entry in the strip carries a mark, distinct from the unsaved dot;
  - the query toolbar shows *Transaction open* and how long it has been open, with **Commit** and
    **Rollback**;
  - the status bar says how many transactions are open in the window.

  When `XACT_STATE()` is `-1`, the transaction can only be rolled back, so Commit is disabled with
  a word on why.
- **Commit and Rollback:** **Commit** commits every nesting level, as
  `WHILE @@TRANCOUNT > 0 COMMIT` does. **Rollback** runs `ROLLBACK`. Their outcome shows in the
  results' messages like any run, and the session's state is read again.

### Switching database from the sidebar

When the sidebar switches database (`useDatabase`), the app checks each tab that has a session:

- **It follows** when its database was the sidebar's old one and it has no transaction open. The
  app sends `USE [newdb]` on its session.
- **It stays** when it had already moved to another database with its own `USE`, or has a
  transaction open. It then shows its database, as above.
- **It follows later** if its query is running when the switch happens: it follows once that run
  ends, as long as it still has no transaction open. *(my call)*
- **A routine's tab never follows.** It is pinned to the routine's own database: its session opens
  there and stays there, and its toolbar shows the database whenever it differs from the sidebar's.
  Today, saving a routine's tab after a sidebar switch writes the routine into the other database,
  where the same name can be a different routine or none at all. Pinning stops that. *(my call: a
  routine's tab counts as a tab with a database of its own)*

Tabs without a session have nothing to move; their first run opens in the new database. A switch
the server refuses changes nothing, for the sidebar or for any tab.

### Asking before a transaction is ended

Anything that would end a tab's session while `@@TRANCOUNT > 0` asks first, naming the tab and the
database. That covers:

- closing the tab (its ✕, *Close others*, *Close all*);
- moving it to another window, by dragging or with *Move to a new window*, because its session
  cannot go with it;
- disconnecting;
- closing the window, or quitting. The window's unsaved-work flag holds the close, as it does for
  staged edits.

The question offers **Commit and …**, **Roll back and …** and **Cancel**, worded for the cause:
*Commit and close*, *Roll back and disconnect*, and so on. Cancel has the focus and keeps everything
as it was.

The questions come in the existing order: staged table edits first, then routines' unsaved changes,
then open transactions. A commit that fails keeps the tab, puts it on screen with the error, and
stops whatever was closing.

#### When the tab's query is still running

While a run is going, the app can't know whether it has opened a transaction. Nothing can be sent
on the session until the run stops, not even a commit. Today, closing a tab leaves its query
running to the end on the pool, unseen, while disconnecting and quitting cancel it.

- **No transaction open before the run:** closing the tab, moving it, disconnecting, closing the
  window or quitting first stops the query, the way Cancel does. The app then reads the session's
  state, and asks only if a transaction is open by then; the question says the run was stopped
  part-way. Closing a tab therefore now stops what it is running. *(my call)*
- **A transaction already open before the run:** the app asks before stopping anything: *Query 2
  is running inside an open transaction*, with **Stop and roll back** and **Cancel**. Commit is not
  offered until the query has stopped.
- **Window close and quit:** these are held while any tab's query is running, as well as while a
  transaction is open, so the steps above can happen. The window shows that it is stopping
  queries. If a query has not stopped after 10 seconds, the window closes anyway; that ends the
  session, and the server undoes its unfinished work. *(my call)*

### When a session is lost

A session is lost when its connection ends without the tab ending it: the server killed it, its
socket closed, or the whole connection dropped.

- **Never replaced behind the tab's back.** The session's connection is held so that nothing
  reopens it on its own (see *Left to the builder*). When the connection ends, the driver reports
  it and the tab is marked lost straight away. A socket that died without a word is found when
  the next run fails to reach it, and then nothing has run.
- **The tab says so once,** in its results area: *This tab's session was closed — temp tables and
  settings from earlier runs are gone*. When a transaction was open, it adds *its open transaction
  was rolled back by the server*.
- **The next run depends on what the lost session had:**
  - **Nothing is sent** if the session had a transaction open, or was in a database other than
    the one a new session would open in (a tab that had run its own `USE`). The results say the
    session was closed, what that undid, and that the next run starts a new session in that
    database. A script written to carry on inside the transaction is never committed statement
    by statement on a new session, and nothing runs in a database the tab didn't mean.
  - **Otherwise,** the run opens a new session and goes ahead, with the note above its results.

  *(my call: refusing every first run after a loss would put a new obstacle in front of people
  who never use transactions every time a laptop wakes and the connection is reopened)*

### Drops, reconnects and keepalive

- **Whole-connection drop:** when the connection drops (`handleDrop`), every session goes with the
  pool. Each tab that had one is told, as above, once the drop is noticed.
- **After a reconnect:** sessions are not reopened by the reconnect. A tab's next run opens a new
  session on the new tunnel endpoint; the local port can change.
- **One session failing:** a transport failure on one session, such as its socket being reset, ends
  that session only. Today `noteTransportFailure` reopens the whole connection on any such failure.
  Instead, check the shared pool straight away: only if the pool fails too is the whole connection
  reopened.
- **A killed session:** a session the server kills is not a transport failure. Its running query
  gets *Cannot continue the execution because the session is in the kill state* (checked against
  the test container), and the session is lost as described above. Either way, the other tabs'
  sessions are untouched.
- **Keepalive:** idle sessions get the same keepalive as the pool (`keepAliveIntervalMs`), so a
  tunnel or firewall does not cut them off. The pool's heartbeat and each session's heartbeat each
  skip only while that pool, or that session, is busy. Today the pool's heartbeat skips whenever
  any request is running. A failed heartbeat on a session marks that session lost.

### Other things that change with it

- **History** records the database the tab's session ran in, rather than the window's.
- **Connection count:** `poolMax` still sizes only the shared pool. Sessions come on top of it:
  one connection per tab that has run something, with no cap, which is what an SSMS window costs.
  *(my call)*

## Calls I made (for the user to check)

- Sessions sit outside the shared pool's `poolMax`, with no cap.
- After every run the tab reads `@@TRANCOUNT`, `XACT_STATE()` and `DB_NAME()` on its session.
- Commit commits every nesting level; Rollback rolls all of it back.
- The open-transaction marker shows how long the transaction has been open, and the status bar
  counts open transactions in the window.
- A following tab whose query is running during a database switch follows when its run ends.
- A routine's tab is pinned to the routine's database and never follows the sidebar.
- After a lost session, the next run is refused only if the session had a transaction open or was
  in a database of its own. Otherwise it runs on a new session, with a note.
- Closing, moving or disconnecting a tab whose query is running stops the query first, and asks
  only if that leaves a transaction open. A run inside a transaction that was already open asks
  before stopping, offering *Stop and roll back* or *Cancel*.
- Window close and quit wait up to 10 seconds for running queries to stop.
- The question before ending a transaction gives Cancel the focus.
- Moving a tab to another window asks only about an open transaction. Its temp tables and settings
  don't move and aren't asked about; the docs say so.
- Idle sessions are kept alive at the connection's keepalive interval.
- A transport failure on one session ends that session, not the whole connection, unless the
  shared pool fails too.

## Left to the builder

- **Holding a session in `SqlServerClient`,** within one requirement: the connection is never
  replaced without the tab knowing (see *When a session is lost*).
  - **The shared pool's configuration won't do.** mssql 12.7 validates a connection before handing
    it out (`validateConnection` defaults to on), and tarn swaps a dead or closed one for a new one,
    which would run the next script on a fresh session.
  - **Workable shapes:**
    - a one-connection `sql.ConnectionPool` with `validateConnection: false` and no idle close.
      Its tedious connection is caught in `beforeConnect`, so its `end` is seen before the next run
      asks the pool for it, and it is replaced by a new pool only when the tab is to get a new
      session. That keeps `executeOne` as it is, told which pool to use;
    - a tedious `Connection` held directly.
  - **Either way,** `buildMssqlConfig` builds it with the session's database and the client's
    current tunnel endpoint. `@@SPID` is not the check, because SQL Server reuses SPIDs.
- **The shape of the IPC.** For example:
  - `RunQueryRequest.sessionId`, set to the tab id. Tab ids are unique within a window, and the
    registry is scoped per window.
  - The session's state returned with each `QueryExecutionResult`.
  - A call to close a session, and one to commit or roll back.
  - An event for state that changes without a run: a sidebar switch moved the session, or a drop
    lost it.
- **The question's dialog:** a new one, or an extension of the close prompt in
  `UnsavedRoutineDialog.vue`.
- **The look** of the tab mark, toolbar indicator and status bar text, within the design system.
- **Commit and Rollback's path:** through the normal run path, so they appear in history, or
  through a dedicated call.

## Testing

- **Integration tests** (`test/integration/`), against the test container: the table above,
  turned round.
  - **Temp tables survive:** one made in one run is still there in the next, with reads on the
    shared pool in between. It is also there after longer than the pool's idle timeout; set
    `poolIdleTimeoutMs` low in the test's config to keep that quick.
  - **`USE` stays in the session:** `USE master` in a session leaves `fetchTableData` and
    `listObjects` in the window's database.
  - **Open transactions stay in the session:** the shared pool's reads do not see an open
    transaction's changes; use a short lock timeout in the test so a blocked read fails fast.
    Closing the session rolls the transaction back.
  - **The database rule:** a sidebar switch moves a following session, and leaves one in a
    transaction, or one that ran its own `USE`, where it was.
  - **One failing session:** killing one session's SPID loses that session only; the pool and the
    other sessions carry on.
  - **No silent replacement:** after the server kills a session that had a transaction open, the
    next run sends nothing. After it kills one with nothing open, the next run goes ahead on a new
    session and says so.
  - **Routines stay put:** a routine's tab saves into the routine's database after a sidebar
    switch.
- **Unit tests** for the pure logic:
  - the follow-or-stay rule, including routine tabs;
  - the tab state derived from what is read after a run;
  - the refuse-or-run rule after a lost session;
  - the questions asked by `close`, `closeConnection`, `canCloseWindow` and moving a tab, with
    transactions open, and with queries running.
- **An e2e check**, beside `test/e2e/unsaved.mjs`: `BEGIN TRAN` in a tab shows the marker, closing
  the tab asks, and Cancel keeps it.

## Docs and release

- **`docs/query-editor.md`:** a section on tabs and their sessions: what carries over, the
  database rule, transactions and the questions, and drops.
- **`docs/read-only.md`:** `USE` now changes only the tab it ran in.
- **`docs/architecture.md`:** the decision, query tabs on sessions of their own and the app's own
  reads on the shared pool, and why.
- **Release:** the change ships, so per `CLAUDE.md` it is the first change since `v0.2.1` and a new
  feature. That means `npm version minor --no-git-tag-version` (0.3.0) and a `CHANGELOG.md` entry
  under `## 0.3.0`.
