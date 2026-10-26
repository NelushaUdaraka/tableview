# Changelog

What changed in each release of TableView, newest first. The downloads are on the
[Releases page](https://github.com/NelushaUdaraka/tableview/releases); a version at the top that is
not there yet is the next release, still being prepared.

## 0.4.0

- Execution plans: *Plan* in the query toolbar (or `Ctrl+L` / `Ctrl+M`) shows how SQL Server runs a
  query — the estimated plan without running it, or the actual plan after running it — as a tree of
  operators with each one's share of the cost, estimated against actual rows (big gaps marked),
  warnings such as implicit conversions and spills, and missing-index hints as a `CREATE INDEX`
  statement to copy. Save a plan as `.sqlplan` to open it in SSMS too. An estimated plan runs
  nothing, so it works on read-only connections as well.
- Import a CSV file into a table — *Import* in the table's toolbar, *Import CSV…* on its menu in
  the tree, or drop the file on the rows. A preview matches the file's columns to the table's by
  name, lets you choose whether empty cells are NULL or empty text, and lists every row with a
  problem before anything is sent. The rows arrive staged, to look over and Apply in one
  transaction; thousands of them go up in a few statements.
- Paste a range copied from Excel or Google Sheets into a table's grid with `Ctrl+V`: over existing
  rows it stages changes, and past the last row it adds new ones.
- An activity monitor (View → Activity Monitor): every session on the server, what it is running,
  what it is waiting on and for how long, and who is blocking whom — shown as chains with the head
  blocker first. Kill ends a session once you say so, and is refused on a read-only connection.
  TableView's own sessions are marked, so you don't kill the one you are using. It refreshes on the
  same intervals as a table, and says which permission is missing when the login cannot see the
  other sessions.
- Quick open: press `Ctrl+P` from anywhere, type part of a name, and press Enter to open that
  table, view, procedure, function or saved query. Pinned tables and what you had open lately come
  first; `Shift+Enter` opens a table's structure instead. It works in a window holding a single
  dragged-out tab too, which has no schema tree.
- A query that runs longer than ten seconds and finishes while TableView is in the background now
  says so with a desktop notification: which tab, how long it took, and how many rows came back or
  what the error was. Clicking it brings that window and tab forward. Turn it off, or change the ten
  seconds, in Settings.
- Select two rows or more in a table or in query results and the footer adds up the focused
  column for you, as a spreadsheet does: count, sum, average, minimum and maximum for a number
  column, the count and how many distinct values for anything else, with NULLs counted apart. It
  covers the rows that are loaded — a table's current page — and says so.
- Search inside stored procedures: the sidebar's new *Search* panel finds text across every
  procedure, function, view and trigger in the database and shows the lines it is on, with options
  to match case, match whole words and pick which kinds of object to search. Clicking a line opens
  that definition scrolled to it, ready to edit. Encrypted ones are listed as *can't be searched*.
- *Find references* on a table, view or routine in the schema tree lists the procedures,
  functions, views and triggers that use it, in the same list.
- *Apply* in a table now shows the statements it is about to run, in the order it runs them,
  values written in, instead of only counting them. *Copy as script* puts the same statements on
  the clipboard wrapped in one transaction, to keep for a change ticket or to run on another
  server. Turn the review off with *Confirm before applying a change set* in Settings.
- Truncate, Drop and deleting a connection now ask in the app's own dialog rather than the
  system's, which froze the window until it was answered.
- A connection can now confirm its writes: a setting between read-only and writable, for the
  production connection you do sometimes need to change. Turn on *Confirm writes* (beside
  *Read-only* in the status bar, in the connection list's ⋮ menu, or on the connection's General
  tab) and anything that would change the database is shown to you first: every statement in the
  script that writes, with its line and the database it changes, and nothing is sent until you
  press *Run anyway*. The same question comes before *Apply* in a table and before *Truncate* and
  *Drop* in the tree.
- On such a connection, a `DROP`, a `TRUNCATE`, and an `UPDATE` or `DELETE` with no `WHERE` also
  ask you to type the table's name before they will run.
- With *Read-only* on as well, nothing writes; turning read-only off then leaves the connection
  confirming its writes rather than writing freely.
- A connection pasted from TablePlus with a safe mode on now arrives confirming its writes, instead
  of read-only.

## 0.3.0

- Each query tab now keeps its own session with the server, as an SSMS query window does. A temp
  table, a `SET` option or a `USE` from one run is still there for the tab's next run, however long
  you wait between them, and stays in that tab.
- A transaction left open is shown: the tab carries a clock, its toolbar says *Transaction open*
  and for how long, with *Commit* and *Rollback* beside it, and the status bar counts them. Closing
  the tab, moving it to another window, disconnecting, closing the window or quitting asks first
  whether to commit it or roll it back. Before, an open transaction was quietly rolled back about
  thirty seconds later.
- A `USE` in a query tab no longer sends the table tabs and the schema tree to another database.
- A procedure's or function's tab stays in the database it was opened from, so saving it after
  switching database in the sidebar no longer writes it into the other database.
- If a tab's session is lost — the connection dropped, or the server ended it — the tab says what
  went with it, and a run written to carry on inside an open transaction is not sent on a new one.

## 0.2.1

- Typing `>=` or `<=` into a text box, such as the filter's raw `WHERE` or a field in the row panel,
  no longer shows it as `=`. Text boxes now show exactly the characters you type, without the
  joined-up symbols the code font draws for them in the SQL editor and the grid.

## 0.2.0

- TableView remembers how you left it: after a restart the sidebar comes back at the same width,
  shown or hidden as you left it and on the same Schema, History or Saved panel, the query editor
  keeps its height, and a table you left refreshing automatically refreshes again at the same
  interval when you next open it (choose *Off* to stop that).
- Connecting reopens the tabs you had open on that connection last time, even after a restart: the
  same queries with their text, the same tables, split panes and all. Results, staged edits and a
  procedure's unsaved changes are not brought back. Turn it off in Settings (*Reopen a connection's
  tabs when connecting to it again*), which also deletes the tabs already saved.
- Connecting opens in the database you last switched to from the sidebar, instead of going back to
  the connection's default one. If that database is gone or you can no longer open it, TableView
  opens the default one instead.
- Switching to a database the server refuses no longer leaves the connection broken: it stays in
  the database it was in.
- A narrow sidebar no longer pushes the Schema, History and Saved switch past its edge: the labels
  shorten to fit instead.
- In a narrow window the connection list no longer hides the names of read-only connections: their
  *Read-only* badge shrinks to its lock icon so the name keeps its room.

## 0.1.3

- Restarting to install an update no longer just makes TableView vanish: the window says it is
  installing the new version, and on Windows the installer then opens in view with its progress
  (click *Next* and *Finish*, and TableView starts again) instead of working silently. Once it is
  back, a notice says which version it was updated to, with a link to what is new in it.

## 0.1.2

- The sidebar opens wider, at 320px rather than 280px, so table names are cut short less often.
- Toasts put themselves away: a notice after four seconds, as before, and now an error too, after
  eight. Resting the pointer on a toast holds them all until it leaves. The update notices with
  *Restart* or *Download* on them still wait for an answer.

## 0.1.1

- Every download is named for the system and the processor it runs on —
  `TableView-0.1.1-windows-x64-setup.exe`, `TableView-0.1.1-linux-x86_64.AppImage`,
  `TableView-0.1.1-linux-amd64.deb` and so on — so a release page says which file is for which
  computer. Installed copies keep updating as before.

## 0.1.0

- The first release: an installer and a portable exe for Windows, and AppImages and .debs for Linux
  on x64 and arm64. The installer and the AppImages update themselves from these releases.
