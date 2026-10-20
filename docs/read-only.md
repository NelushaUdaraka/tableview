# Read-only connections

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
`WAITFOR`, `USE`. The connection list marks a read-only connection before it is opened, and once it
is, the status bar and the query and table toolbars carry a lock.

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

Turning it on just happens. Turning it off always asks first — *Turn off read-only?* — naming the
connection and the server and database it is about to write to. *Keep read-only* has the focus, so
Enter or Escape leaves it on, and only *Turn off read-only* takes it off. Asked over the connection
form, Escape answers the question and leaves the form open as it was; the form's own change still
waits for *Save*.

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

The check sits in the main process, beside the code that sends the SQL, so the grid not offering
an edit is a courtesy rather than the protection: an edit, a truncate or a drop that reaches the
main process for a read-only connection is refused there too. The window takes its lock from the
main process's word on the open connection rather than from the saved list, so the two cannot
disagree: a switch changes the open connection in the main process first, and each window that has
it open is told after.

## A safety net, not a permission

It is a safety net for the window you took for staging, not a permission. What a connection may do
is decided by its login, and for a guarantee that means a login that can only read. *Read-only
intent* on the Advanced tab is a different thing again: it asks an availability group to route the
connection to a readable secondary, and stops nothing on its own.
