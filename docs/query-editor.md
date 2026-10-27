# Query editor

- CodeMirror 6 with T-SQL highlighting and **completion of keywords, tables and the columns of
  the tables the statement reads**, pulled from the live database — see below
- **Snippets**: your own reusable pieces of T-SQL, inserted from completion by a short prefix, with
  placeholders Tab moves between — see below
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
- **A long query says when it is done** — see below
- **Execution plans**, estimated (`Ctrl+L`) or actual (`Ctrl+M`), drawn as a tree of operators with
  their costs, row counts, warnings and missing-index hints — see below

## Completion

Completion pops up as you type (`Ctrl+Space` asks for it anywhere). Keywords and table names come
from lang-sql, bare (`Customers`) or schema-qualified (`dbo.` lists the schema's tables). Columns
come from a source of the app's own (`lib/columnCompletion.ts`), because lang-sql offers them only
after an exact-case `table.` and cannot see which tables a statement reads:

- **A bare word** — in the `SELECT` list, `WHERE`, `ON`, `GROUP BY`, `ORDER BY`, `SET` — is offered
  the columns of every table the statement under the cursor names after `FROM`, `JOIN`, `UPDATE`,
  `INTO`, `DELETE`, `INSERT`, `MERGE` or `USING`, each with its table beside it and ranked above
  the keywords. The `FROM` can come after the cursor: `SELECT Na| FROM Customers` works.
- **After `name.`**, only that table's columns: `c.` resolves the alias in `FROM Customers c` or
  `FROM Customers AS c`, `Customers.` and `dbo.Customers.` name the table outright (in the
  statement or not), and bracketed names (`[Order Details].`) work the same. Names are matched
  without regard to case, as SQL Server matches them, and keywords are left out of the list there.
- **Nothing** where a column cannot go: right after `FROM` and the other table keywords, after
  `AS`, in comments and strings, and for `@variables` and `#temp` tables.

A column whose name needs brackets (`Unit Price`, `Key`) is inserted with them. The statement is
the one under the cursor as run-statement finds it (`;` and `GO` end it), read by a lexer rather
than a parser, so a half-typed query works as well as a finished one. Columns come from the same
list the schema store loads for the connection, tables and views alike; a derived table or a CTE
offers none of its own.

## Snippets

A snippet is a piece of T-SQL typed often enough to be worth a name: a guarded transaction, a
`TRY…CATCH`, a team's audit columns. Type its prefix in a query tab — `tran` — and it is in the
completion list beside the keywords, ranked above them, with its name and a preview of what it
inserts; pick it and the text goes in with its first placeholder selected. Type over it, press Tab
for the next, Shift+Tab to go back, Escape to stop.

```
tran ▸ Guarded transaction           BEGIN TRAN;

                                     -- statements

                                     -- Look at the results, then swap these two lines to keep them.
                                     ROLLBACK;
                                     -- COMMIT;
```

**Placeholders** are written `${1:name}`, `${2:value}`, … and visited in that order. The same
number twice is one placeholder in two places, edited in both at once (`${1:dbo.table}` in the
`OBJECT_ID` check and in the `DROP`), and `${0}` is where the cursor ends up. A literal `{` or `}`
right after a `$` or a `#` is written `\{`, `\}`. Snippets are offered where a word of code is being
typed — not after a `.`, on an `@variable` or a `#temp` table, or in a comment or a string.

**The starter set** a new install begins with: `tran` (guarded transaction), `trycatch` (`TRY…CATCH`
that commits or rolls back and rethrows), `droptable` (`IF OBJECT_ID(…) IS NOT NULL DROP TABLE …`,
which works on every version), `temptable`, `page` (`OFFSET … FETCH`) and `cte`. They are ordinary
snippets: edit them, delete them, and *Restore starters* puts back any that are gone.

**Managing them**: *Query → Snippets…*, or *Manage snippets…* in Settings, lists them with an editor
beside the list — name, prefix, an optional description shown in completion, the text, and what it
inserts. Edits are made to a copy and saved together with **Save**, so a half-finished snippet never
reaches completion; a snippet with no name, a prefix of more than one word (letters, digits and
`_`), no text, or a prefix another one already uses is pointed out instead. Cancel (or Escape) asks
before dropping unsaved edits.

**Where they live**: `snippets.json` in the app data folder, next to the saved queries, written by
the main process the same new-file-then-rename way. A window reads the list when it opens and
whenever it gets the focus, so an edit made in one window reaches the others. **Export…** writes the
list to a JSON file (`tableview/snippets`, without the machine's ids) for a team to share;
**Import…** merges one in — a snippet whose prefix is already in the list replaces it, the rest are
added — and says which were which. `shared/snippets.ts` holds the starter set, the checks and the
file format.

## Execution plans

**Plan** in the query toolbar, or the Query menu, shows how SQL Server runs the selection — or the
whole tab, when nothing is selected:

- **Estimated plan** (`Ctrl+L`) compiles it without running it: the tab's session is put under
  `SET SHOWPLAN_XML ON`, the script is sent batch by batch, and SQL Server answers each batch with
  its plan instead of its rows. Nothing runs, so nothing changes — which is why a read-only
  connection allows it for a write too (see [read-only](read-only.md#how-a-script-is-checked)).
- **Run with actual plan** (`Ctrl+M`) runs it under `SET STATISTICS XML ON`, so each statement's
  rows come back as usual with its plan beside them, carrying the rows each operator really
  produced.

Either way the option is turned off again after the script, whether it succeeded or not — in the
same turn on the tab's session, so nothing else (a heartbeat, a move with the sidebar) is let in
between — and the tab's next run is an ordinary one. Plans are lifted out of the results (any result
set of one `Microsoft SQL Server 2005 XML Showplan` column is one, so a script that sets
`STATISTICS XML` itself gets the same tab) and the results open on the **Plan** tab:

```
 ACTUAL PLAN                                              Copy XML   Save as .sqlplan
 SELECT  100% of the batch · cost 0.122 · 4 ms elapsed, 4 ms CPU
 ⚠ Implicit conversion CONVERT_IMPLICIT(nvarchar(20),[b].[code],0)=N'C12' may affect the use of an index seek
 ⓘ Missing index · SQL Server estimates it would improve this statement by 96%      Copy
   CREATE NONCLUSTERED INDEX [IX_plan_big_code]
   ON [shop].[dbo].[plan_big] ([code]);
 Operator                                   Cost        Est. rows  Actual rows  Executions
 ▾ Sort                                     ██  9%           3.66            1           1
   ▾ Stream Aggregate  Aggregate               0%           3.66            1           1
     ▾ Nested Loops  Inner Join             ▏  1%             3.7            5           1
         Clustered Index Scan  [dbo].[plan_big].[PK_…] [b]   ████ 88%   3.7    5    1
```

- **Cost**: each operator's own share of its statement's estimated cost — its subtree's cost less
  its children's — with a bar, and each statement's share of the batch.
- **Rows**: estimated rows, over every execution, against the actual rows from an actual plan; an
  operator ten times or more off its estimate either way is marked, since that is most often why a
  plan is poor. Hovering says how it was counted.
- **Warnings**: implicit conversions that stop a seek or skew estimates, columns with no
  statistics, spills to tempdb, a join with no predicate, memory-grant warnings and waits — on the
  statement or on the operator they belong to.
- **Missing indexes**: each hint as the `CREATE NONCLUSTERED INDEX` it suggests — equality
  columns, then inequality ones, then `INCLUDE` — with its estimated improvement, to copy.
  Treat it as a hint: SQL Server suggests it for this statement alone.
- **Save as .sqlplan** writes the plan XML as it came, which SSMS also opens; **Copy XML** copies it.

The tree folds at each operator. The XML is read in the window by a small parser of its own
(`shared/xml.ts`, `shared/showplan.ts`), the same in the app and in the unit tests.

## When a long query finishes

A query that has been running for a while and finishes while its window is not the one in front
sends a desktop notification: which tab ran, how long it took, and how many rows came back (or
were affected), or the error it stopped on, cut to its first line. Clicking it brings that window
forward with the tab showing. A quick run, a run in the window you are looking at, and a run you
cancelled never notify.

*Settings → Notify when a query that ran longer than … seconds finishes in the background* turns it
off and sets the threshold (10 seconds to begin with, one at the least). The window decides
whether a run is worth a word (`lib/runNotice.ts`), from how long it took by the clock and whether
the document has the focus; the main process shows it with Electron's `Notification`. On Windows
that needs the app's AppUserModelID to be the installer's `appId` (`com.tableview.app`), which the
main process sets as it starts. On Linux it needs a notification daemon, and where there is none
nothing is shown and nothing complains.

## Each tab has a session of its own

A query tab runs on a SQL Server session of its own, the way an SSMS query window does: the tab's
first run opens it, and it stays the tab's until the tab closes. What a script sets up on it is
there for the next run, however long that is in coming — a `#temp` table, a `SET` option
(`SET STATISTICS IO ON` keeps reporting), a `USE`, a transaction — and none of it reaches anything
else: not the other tabs, and not the table tabs, the schema tree or completion, which read
through the window's own shared connections. Under `SET SHOWPLAN_XML`, `NOEXEC` or `PARSEONLY` the
server compiles what the tab sends without running any of it until the option is turned off, and
the tab keeps its session, transaction and all, as SSMS does.

**Where a tab runs.** A new tab's session opens in the database the sidebar shows. Switching
database from the sidebar takes the tabs along, each with a `USE` the app sends for it — except a
tab that has gone somewhere of its own with a `USE`, and a tab with a transaction open, which stay
where they are. The sidebar does not wait for the tabs: each moves in its turn, so a tab whose
query is running when the switch happens follows once the run ends, and a run started while its
tab is moving waits for the move.
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
nothing of the kind to lose, the next run starts the new session and goes ahead. Pressing
*Reconnect* after a drop the app gave up on is no different: the tabs' sessions do not come back
with the connection, and each tab's next run is held to the same rule.

## Searching definitions

The sidebar's *Search* panel finds text across every procedure, function, view and trigger in the
current database, and shows the lines it is on, grouped by object:

```
 orders_total                                  Aa ab
 [Procedures] [Functions] [Views] [Triggers]

 "orders_total"                                    ✕
 5 lines in 2 objects
 ▫ sales.usp_month_end                            3
     12  UPDATE m SET orders_total = s.total
     18  WHERE orders_total > 0
     40  RETURN @orders_total
 ◉ sales.v_customer_totals                        2
      3  SUM(o.total) AS orders_total,
      …
```

Enter runs it. **Aa** matches case and **ab** whole words only — a word stops at anything that is
not part of a T-SQL name, so `orders` does not find `@orders` or `orders_archive` but does find
`[orders]` and `dbo.orders`. The chips narrow it to some kinds of object; changing any of them
searches again. Clicking a line opens the object's definition at that line with the match
selected, through the same path as clicking a routine in the tree, so it opens as `CREATE OR ALTER`
with its changes marked (below); views and triggers open the same way. A routine already open is
shown where it is, scrolled to the line.

It is one catalog query: `sys.sql_modules` joined to `sys.objects`, `definition LIKE @pattern
ESCAPE '\'`, with the text bound as a parameter and its wildcards escaped, so `%`, `_` and `[` mean
themselves. The collation is spelled out (`Latin1_General_100_CI_AS`, or `_CS_AS` to match case),
so case means the same whatever the database's own collation is. The server narrows it to the
objects that contain the text; the lines, and whole-word matching, are worked out in the main
process, and only the lines cross to the window — never whole definitions. At most 500 objects
and 50 lines per object are listed; the rest are counted. Encrypted modules have no definition to
search, so they are listed under *Can't be searched* rather than left out. Results belong to the
database they were found in, and go when the sidebar switches database. Both this and *Find
references* (see [tables](tables.md#where-a-table-is-used)) only read the catalog, so they work on
read-only connections.

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
