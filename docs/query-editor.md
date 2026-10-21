# Query editor

- CodeMirror 6 with T-SQL highlighting and schema-aware completion pulled from the live database
- Run all / run selection / run the statement under the cursor; cancel a running query
- Scripts split on `GO` (like SSMS), so `BEGIN … END` bodies and `CREATE PROCEDURE` work; `GO 5` repeats
- Multiple result sets per batch, rows-affected, `PRINT` output, and errors with their
  message number, state and line
- Results sort by clicking a header — a local reorder, since the statement is yours to re-issue, not
  ours to rewrite — with NULLs kept at the end either way
- SQL formatting, open/save `.sql` files, saved queries, searchable query history
- **A routine's definition shows what you changed in it**, and lets you put back any one change on
  its own — see below
- **Each tab keeps a session of its own**, so a temp table, a setting or a transaction is still
  there for the tab's next run; an open transaction is shown, and asked about before anything
  ends it — see below

## Each tab has a session of its own

A query tab runs on a SQL Server session of its own, the way an SSMS query window does: the tab's
first run opens it, and it stays the tab's until the tab closes. What a script sets up on it is
there for the next run, however long that is in coming — a `#temp` table, a `SET` option
(`SET STATISTICS IO ON` keeps reporting), a `USE`, a transaction — and none of it reaches anything
else: not the other tabs, and not the table tabs, the schema tree or completion, which read
through the window's own shared connections.

**Where a tab runs.** A new tab's session opens in the database the sidebar shows. Switching
database from the sidebar takes the tabs along, each with a `USE` the app sends for it — except a
tab that has gone somewhere of its own with a `USE`, and a tab with a transaction open, which stay
where they are. A tab whose query is running when the switch happens follows once the run ends.
A routine's tab never follows: it belongs to the database its routine lives in, so saving it after
a switch writes the routine back where it came from rather than into the database the sidebar
moved to. Whenever a tab's database is not the sidebar's, its toolbar says which it is.

**Transactions.** A transaction left open after a run stays open — holding its locks — until it is
committed or rolled back, and the tab says so: a clock beside its name, *Transaction open* and for
how long in its toolbar, with **Commit** and **Rollback** beside it, and a count in the status bar.
Commit commits the whole transaction, however many `BEGIN TRAN`s deep; Rollback undoes all of it.
Both run in the tab like any script, so what they did shows in its results and its history. A
table tab reading rows the transaction has changed waits for it, as it would in SSMS — unless the
database uses read-committed snapshot, when it reads the rows as last committed — and the tab with
the clock is where to look.

**Before a transaction ends.** Ending a tab's session ends its transaction, so whatever would —
closing the tab, *Close others*, *Close all*, moving the tab to another window, disconnecting,
closing the window, quitting — asks first: *Commit and close*, *Roll back and close*, or *Cancel*,
which keeps everything as it was and has the focus. A tab with no transaction open is asked
nothing new. A query still running is stopped first, as its Cancel button would, and the tab is
asked about only if that leaves a transaction open; one running inside a transaction that was
already open is asked about before it is stopped, with *Stop and roll back*. A query that does not
stop within ten seconds is not waited on: its session ends, and the server undoes what it had not
finished. A tab moved to another window starts a new session there — its temp tables and settings
stay behind with the old one.

**A lost session.** When a tab's session ends without the tab ending it — the connection dropped,
the server killed it — the tab says so above its results, once, with what went with it: temp
tables and settings, and an open transaction, which the server rolls back. A session is never
quietly replaced. If the lost one had a transaction open, or was in a database of its own, the
next run sends nothing and says why — a script written to carry on inside the transaction would
otherwise be committed statement by statement — and the run after that starts a new session. With
nothing of the kind to lose, the next run starts the new session and goes ahead.

## Editing a stored procedure

Clicking a procedure or function in the tree opens its definition as `CREATE OR ALTER`, so running
the tab saves it back. That tab remembers what the server holds, and the editor marks every line
that differs from it, the way a source-control gutter does — a bar beside lines that changed or were
added, a wedge where lines were taken out:

```
   5    SET NOCOUNT ON;
   6 ▌  SELECT order_id, customer_id, total            ← changed
     ┌ CHANGE 1 OF 3 · 1 line changed  [Revert] ‹ › ✕ ┐
     │ STORED                                          │
     │   6    SELECT order_id, customer_id             │
     └─────────────────────────────────────────────────┘
   7      FROM sales.orders
   8 ▌    -- only the ones asked for                   ← added
   9      WHERE status = @status
  10 ▸ END                                             ← ORDER BY removed above
```

Clicking a mark opens a strip under the change showing what the stored routine had there, and
**Revert** puts back that change alone; the others stay where they are. Every revert is an ordinary
edit, so `Ctrl+Z` takes it back. The toolbar counts the changes, steps through them (`Alt+F5`, `Shift+Alt+F5`) and
reverts the lot; `Ctrl+Alt+Z` reverts the change under the cursor.

Running the whole tab without an error is what saves the routine, so from then on the marks are
measured against what was run — in every tab open on that routine. A selection, a single statement,
a failure or a cancel moves nothing. It is the script that ran rather than the definition read back,
because SQL Server does not keep what it was sent: `CREATE OR ALTER` comes back as `CREATE` with the
`OR ALTER` blanked out, and comparing against that would mark the first line of every routine the
moment it was saved. A definition stored with Windows line endings reads the same as the editor's.

A routine already open is shown where it is rather than opened twice — each tab has its own idea of
what is stored and what has changed, and two of them would quietly undo each other's saves. The
tab's dot means "differs from the database", so it goes away once the changes are run or reverted.

Closing a routine's tab with its changes unsaved asks first, the way a table with staged edits
does: **Save and close** runs the script, **Discard** closes without it, **Cancel** keeps the tab.
The difference is where the work lives. A table's staged edits live in its view and are gone the
moment it is unmounted; a routine's text lives on the tab, so switching away loses nothing and never
asks — but closing does, whether the tab is on screen or not: its ✕ in the background, *Close
others* and *Close all* all ask about every routine they would close. A save that fails keeps the
tab and puts it on screen with the error; dragging the tab into another window takes its text
along, so that does not ask either.

Disconnecting, closing the window and quitting take every tab with them, so they ask the same
questions — tables' staged edits first, then each routine — and say which of them it is: "Save and
disconnect", "Save and quit". Cancel on any one keeps the connection, the window and every tab as
they were. A window's close is held by the main process while the window says it has unsaved work,
and quitting asks each such window in turn, bringing it to the front; quitting needs asking for on its
own, because with connections open the app exits outright and no window ever gets a close event.
