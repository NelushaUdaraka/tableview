# Activity monitor

What is happening on the server right now: its sessions, the requests they are running, what each
is waiting on, and who is blocking whom. It is the first place to look when a query hangs — is it
blocked, and by whom? — without having to remember the DMV query that answers it.

**View → Activity Monitor** opens it as a tab of its own, beside the query and table tabs. There is
one per connection in a window, so asking again shows the one already open; it splits, drags into a
window of its own and comes back after a restart like any other tab.

```
 ⌁ Activity   9 sessions · 2 running · 1 blocked        [Filter]  Idle sessions  Refresh  Auto 5s
 ─────────────────────────────────────────────────────────────────────────────────────────────────
 BLOCKING 1
 ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 │ 61 head blocker  sa on web01 · api      sleeping · transaction open   BEGIN TRAN; UPDATE …     │
 │   ↳ 62  reporting on bi01 · Excel       LCK_M_S 12.4 s                SELECT … FROM orders     │
 └───────────────────────────────────────────────────────────────────────────────────────────────┘
 Session  Status     Login  Host   Program  Database  Wait         Blocked by  CPU  Reads  …  Statement
 61       sleeping   sa     web01  api      shop                                 3     48     BEGIN TRAN; …
 62       suspended  …                                LCK_M_S 12 s 61            1     20     SELECT …
```

## What it shows

Every user session (`sys.dm_exec_sessions`), with the request it is running if any
(`sys.dm_exec_requests`: its status, command, `blocking_session_id`, `wait_type`, `wait_time`,
`wait_resource`, `cpu_time`, `logical_reads` and elapsed time), the statement inside that request
(`sys.dm_exec_sql_text`, cut to the statement by its offsets), and how many transactions the session
has open. A session with nothing running shows the last thing it sent instead, greyed — which is
how a sleeping session holding a transaction open is recognised, and that is the session that
blocks everyone else (the problem behind TableView's per-tab sessions, see
[the query editor](query-editor.md#each-tab-has-a-session-of-its-own)).

By default only sessions doing something are listed — running a request, waiting, or holding a
transaction open; **Idle sessions** lists the rest too. The filter matches the session number,
login, host, program, database and statement.

**Blocking** comes first, as chains: the head blocker — blocking someone, waiting on no one — and
under it every session waiting on it, each under the one it waits on, the longest wait first. A
head the login cannot see (another database's session, without the permission) is still shown, as
its number. Sessions waiting on each other in a cycle — a deadlock the server has not yet broken —
are shown from the lowest-numbered.

Clicking a session shows its whole statement below the list, with **Copy statement**, **Open in a
query tab** and **Kill**.

**TableView's own sessions are marked**, so the one you are using is not the one you kill: the
monitor's own session (*monitor*), this window's query tabs (*tab*, with the tab's name), and any
other connection this copy of TableView opened (*TableView*). The last is known by the process id
and host name the driver sends the server at login. A query tab's session ends each run with a
state read of the app's own, which is all the server remembers of it; for this window's tabs the
monitor shows the tab's own last batch instead.

## Kill

**Kill** asks first, saying that the session's running statement stops and that whatever its open
transaction changed is rolled back — which takes as long as the work being undone did — and, for
one of TableView's own sessions, which tab loses its temp tables and transaction. It sends
`KILL <session>`; the number is bound as a parameter and cast to an `int` on the server, since
`KILL` takes no variable. A read-only connection refuses it in the main process, as its read-only
check refuses `KILL` in a script; on a confirm-writes connection, the question is the confirmation.
The monitor cannot kill its own session.

## Refreshing

**Refresh** (or `F5` with the tab focused) reads it again; **Auto** re-reads it every 5, 10 or 30
seconds, every minute, or every 5 or 15 minutes — the intervals a table's auto refresh offers — timed
from the end of the last read, and holding off while the connection is down, while a question is
open over it and while the window is out of sight. A read that fails turns it off and says so.

Picking another tab and coming back shows what the monitor last read, through the same filter and
scrolled to the same place, and reads it again only if *Auto* is on — its timer stopped while the
tab was away (see [the workspace](workspace.md#a-tab-comes-back-as-it-was-left)). *Refresh* reads
it whenever you want it current.

It reads through the window's shared pool, never a query tab's session, so watching the server never
waits on a tab's run.

## Permissions

Seeing other sessions needs `VIEW SERVER STATE` on SQL Server, or `VIEW DATABASE STATE` on Azure SQL
Database (told apart by `SERVERPROPERTY('EngineEdition')`). Without it the DMVs answer with the
login's own session alone, so the monitor checks first (`HAS_PERMS_BY_NAME`) and says which
permission is missing, and the `GRANT` that would give it, rather than showing a list of one.
