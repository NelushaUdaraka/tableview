# Read-only and confirm-writes connections

A connection can be guarded two ways. *Read-only* refuses every write. *Confirm writes* is for the
connection you do sometimes need to change: writes go through, but each one is shown to you first
and waits for a yes (see [Confirm writes](#confirm-writes)). Both are switched where they are used,
and both are enforced in the main process.

## Read-only

Turn *Read-only* on for a connection and it refuses to change anything:

- the table grid offers no editing — no *Add row*, no cell editor, nothing to stage — and says why
- *Truncate table…* and *Drop…* stay on the tree's menu, greyed, with "Read-only" beside them
- a script with a statement that writes is not run at all, not even the reads before it, and the
  results say which statement it was and on which line:

```
Not run on a read-only connection, Line 2
DELETE changes data — this connection is read-only, so nothing was run.
```

Reads go on as before: `SELECT`, CTEs, variables, `SET` options, cursors, transactions, `PRINT`,
`WAITFOR`, `USE`. A `USE` changes the database of the query tab it ran in and nothing else — each
tab has a session of its own (see [the query editor](query-editor.md#each-tab-has-a-session-of-its-own)),
so the sidebar, the table tabs and the other tabs stay where they are. The connection list marks a
read-only connection before it is opened, and once it is, the status bar and the query and table
toolbars carry a lock.

## Switching it

It is switched where it is used rather than in the connection's settings. While connected, the
status bar carries a *Read-only* switch beside the connection's name, labelled whichever way it is
so it can be found before it is needed: on, its padlock is closed and the switch filled; off, the
padlock is open and the switch empty. *File → Toggle Read-only* does the same from the menu. In the
connection list, the padlock beside each connection's *Connect* button turns it on or off without
connecting, as does the row's ⋮ menu, and the *Read-only* box on the General tab is still there.
Whichever is used, it is one setting saved with the connection, and it changes at once in every
window that has the connection open: the next statement is checked against it, with no reconnect,
so nothing open in the window is lost. Edits staged in a table before it went on stay staged, with
*Discard* to let them go, and a connection still opening when it is switched opens the way it was
switched.

Turning it on just happens. Turning it off asks first — *Turn off read-only?* — naming the
connection and the server and database it is about to write to. *Keep read-only* has the focus, so
Enter or Escape leaves it on, and only *Turn off read-only* takes it off. Asked over the connection
form, Escape answers the question and leaves the form open as it was; the form's own change still
waits for *Save*. The one time it does not ask is on a connection that also has *Confirm writes*
on: read-only comes off into confirming, and every write will be asked about anyway.

## How a script is checked

The script is read by the app's own T-SQL lexer, with comments, literals and `[quoted]` names
blanked out, and turned down on any reserved word that changes something — `INSERT`, `UPDATE`,
`DELETE`, `MERGE`, `TRUNCATE`, DDL, `GRANT`, `BACKUP`, `DBCC`, `KILL` — and on `SELECT … INTO`.
Reserved words cannot be bare names in T-SQL, so a `DELETE` found in the code is a `DELETE`
statement, while a column called `[delete]` or a string that mentions one goes through. What it
cannot see into it does not guess at: `EXEC`, dynamic SQL, `OPENQUERY`/`OPENROWSET`, and a
procedure called by name at the head of a batch — which SQL Server runs without an `EXEC` — are
refused outright, whatever they would have done. A raw `WHERE` in the filter bar is checked the
same way, since a `;` ends the `SELECT` there as readily as anywhere.

A few writes are spelled with words that are *not* reserved, so a column could have their name.
Those are known by the words that come with them instead: Service Broker's `RECEIVE` (which takes
messages off a queue for good, `WAITFOR (RECEIVE …)` included), `SEND ON CONVERSATION`,
`BEGIN DIALOG`, `BEGIN CONVERSATION TIMER`, `END CONVERSATION` and `MOVE CONVERSATION`, and a
sequence's `NEXT VALUE FOR`, which uses a number up. `t.receive`, `x AS send` and
`FETCH NEXT` are names and paging, and go through; a column called `receive` on its own is taken
for the statement, so write it `[receive]` or with its table.

**An estimated plan is not a run.** *Estimated plan* (`Ctrl+L`) sends the script under
`SET SHOWPLAN_XML ON`, when SQL Server compiles each statement and runs none of them, so a read-only
connection gives the plan of a `DELETE` as readily as of a `SELECT`, and a confirm-writes one does
not ask. The one exception is a script that changes those options itself — `SHOWPLAN`, `NOEXEC`,
`PARSEONLY`, `FMTONLY`, `STATISTICS XML` or `PROFILE` anywhere in it, comments included — since
turning showplan off would let what follows run: that is checked like any run. *Run with actual
plan* (`Ctrl+M`) runs the script, and is checked like any run.

The check sits in the main process, beside the code that sends the SQL, so the grid not offering
an edit is a courtesy rather than the protection: an edit, a truncate or a drop that reaches the
main process for a read-only connection is refused there too. The window takes its lock from the
main process's word on the open connection rather than from the saved list, so the two cannot
disagree: a switch changes the open connection in the main process first, and each window that has
it open is told after.

## Confirm writes

Read-only has no middle setting, and the connection people most want guarded is the one that gets
switched off read-only to run one fix — and can stay that way. *Confirm writes* is that middle
setting. Reads go on as on any connection; anything that would change the database stops first and
asks, in a dialog over the window:

- **A script that writes** lists every statement in it that writes — its line, what it does
  (*DELETE changes data*, *SELECT … INTO creates a table*) and the database it is about to change,
  following any `USE` earlier in the script. Nothing is sent until **Run anyway**, and the focus
  starts on *Cancel*, so Enter or Escape sends nothing. A script that only reads runs without a
  question. Saving a procedure from its tab is running its script, so that asks too.
- **What cannot be taken back** — a `DROP`, a `TRUNCATE`, and an `UPDATE` or `DELETE` with no
  `WHERE` — also wants its table's name (or the database's, for `DROP DATABASE`) typed before the
  button wakes up. Case and the space around it do not matter; the whole name does. A temp table or
  a table variable is scratch and does not ask for its name.
- **Staged table edits** show the statements *Apply* would send, values written in, with *Copy as
  script* beside them (see [Editing a table](tables.md#editing-a-table)), and wait for *Apply
  anyway*. It is the same review *Confirm before applying* turns on elsewhere, asked whatever that
  setting says, with the focus on *Cancel*; it says so when the table has no primary key.
- ***Truncate table…* and *Drop…*** from the tree ask the same question, with the name to type, in
  place of their usual one.

A raw `WHERE` in the filter bar has no way to be confirmed, so a write there is turned down on a
confirm-writes connection just as on a read-only one: a write belongs in a query tab.

The connection list marks a confirm-writes connection with a shield before it is opened, and once it
is, the status bar's *Confirm writes* switch is on and the query and table toolbars carry the same
badge.

### Switching it

*Confirm writes* is a setting of its own, beside *Read-only* rather than a third position of the
same switch: the status bar has a *Confirm writes* switch next to *Read-only*, *File → Toggle
Confirm Writes* does the same from the menu, the list's ⋮ menu has *Confirm writes* / *Stop
confirming writes*, and the General tab has a *Confirm writes* box under *Read-only*. Like read-only
it is saved with the connection and changes at once in every window that has it open.

With both on, read-only wins — nothing writes — and confirm writes is what turning read-only off
lands on. That is why they are two settings: a production connection that confirms its writes can
be made read-only for a while and come back confirming, rather than coming back unguarded.

Turning it on just happens. Turning it off asks first — *Stop confirming writes?* — when that would
leave the connection writing without asking, with *Keep confirming* holding the focus. Behind
read-only it changes nothing yet, so there it does not ask.

### How the question is enforced

The window asks, but the main process decides. A run, an *Apply*, a truncate or a drop on a
confirm-writes connection carries a mark saying it was confirmed; one that arrives without it — from
a window that has not yet heard the connection was switched, say — is refused whole, before
anything is sent, and the results say so:

```
Not run without confirming, Line 2
DELETE changes data — this connection confirms writes first, and this run was not confirmed, so nothing was run.
```

Whether a script needs confirming is the same lexer check read-only makes (see
[How a script is checked](#how-a-script-is-checked)), so anything read-only would refuse is asked
about here, `EXEC` and procedures called by name included. Listing *every* statement, rather than
the first, and spotting a missing `WHERE` are a closer reading of the same words: the parts of a
statement already listed — the `INTO` of an `INSERT INTO`, a `MERGE`'s `THEN DELETE`, an `ALTER
TABLE`'s `ADD` and `DROP COLUMN`, a foreign key's `ON DELETE` — are not listed again, a procedure,
function, view or trigger is listed once however much its body would do, and a `WHERE` counts only
when it belongs to that `UPDATE` or `DELETE` rather than to a subquery or the statement after it.

## A safety net, not a permission

Both are a safety net for the window you took for staging, not a permission. What a connection may
do is decided by its login, and for a guarantee that means a login that can only read. *Read-only
intent* on the Advanced tab is a different thing again: it asks an availability group to route the
connection to a readable secondary, and stops nothing on its own.
