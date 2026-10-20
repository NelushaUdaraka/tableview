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
