# Tables

Finding a table in the schema tree, reading what is in it, and changing it.

## The schema tree

- Database switcher (system databases hidden by default), schema/table/view/procedure/function tree.
  The database switched to is remembered per connection: connecting again, restarts included,
  opens in it rather than in the one the connection's settings name (see
  [the workspace](workspace.md#the-database-you-left-it-in))
- Row-count estimates, live filter box, pinned tables, per-schema collapse
- **Tables open where they stand** into what is in them — `columns`, `keys`, `foreign keys`,
  `indexes`, each with its count — so "what was that column called" costs a twisty rather than a tab
- Context menu: open data, open structure, generate `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`CREATE TABLE`,
  find references, copy qualified name, show routine definition, truncate, drop

### Where a table is used

*Find references* on a table, a view or a routine lists the procedures, functions, views and
triggers that use it, in the sidebar's *Search* panel — the same list a
[definition search](query-editor.md#searching-definitions) fills, with the lines that name it under
each one, and a click opening the definition at that line. It reads
`sys.sql_expression_dependencies`, the dependencies SQL Server recorded when each module was
created: a reference it could resolve then carries the object's id, and one it could not — a name
written without its schema in a procedure, which SQL Server only resolves when the procedure runs —
carries just the name, so those are matched by name (and by schema, when one was written).
What it cannot see is SQL put together at run time (`EXEC (@sql)`, `sp_executesql`); a text search
for the name finds those. A module that uses the object but never spells its name — through a
synonym, say — is still listed, with no lines under it. Encrypted modules are listed as *can't be
searched*, since their text is not shown, though SQL Server still knows what they use.

### A table, opened in the tree

The structure tab spells everything out in tables; the tree has one line per thing, which is the
right shape for finding a name. Clicking a table's twisty reads its structure once, keeps it, and
opens it into the four folders that say what is in it:

```
▾ ▤ com_set_DefaultLocalization                 148
    ▾ COLUMNS                                     9
        ◆ id                        uniqueidentifier
        ▪ locale_code                  nvarchar(10)
        ▪ language_name               nvarchar(100)
        ▪ is_system_default                     bit
    ▸ KEYS                                        3
    ▸ FOREIGN KEYS                                0
    ▸ INDEXES                                     3
```

The primary key is marked with a gold key, as it is in the grid and the row panel; a foreign key
names what it points at and opens that table when it is clicked. "Keys" is the primary key and the unique ones,
each shown once however the DDL declared it — SQL Server backs a `PRIMARY KEY` and a `UNIQUE`
constraint with an index of the same name, so the same key is reported two or three ways. The
structure is the schema store's copy, the one the structure tab and the statement builders already
read, so opening a table twice costs one query, and refreshing the schema re-reads what is open
rather than folding it away.

## Browsing a table

- Virtualised grid — only visible rows are rendered, so large results scroll smoothly
- Server-side paging, multi-column sorting (shift-click to add a key)
- Filter builder (16 operators, AND/OR) and a raw `WHERE` mode; values are always **bound
  parameters**, and `contains`/`starts with`/`ends with` escape LIKE wildcards. **Clear filters**
  in the filter bar takes every filter away at once — the builder's rows and the raw `WHERE` —
  and reads the table again only if the rows on screen went through one; a filter that was only
  drafted goes without a round trip
- Column resize by drag, double-click a divider to fit
- **Choose the columns on show** — *Columns* in the toolbar ticks off the table's columns, with a
  search for wide tables and *Show all* / *Hide all* (which act on the matches while searching);
  *Hide this column* on a header's menu takes one out. Nothing is read for it: the page is read
  whole either way, so keys, edits and the row count are untouched and a column put back is there
  at once. The row panel, the keyboard, copies and exports go by the columns on show. The choice
  belongs to the tab, like its auto refresh — it outlasts a trip to another tab or a reload, and
  goes with the tab into a window of its own — and the button says how many are on show
- **Right-click a column header** for what can be done to that column: sort either way, add it to
  the sort, clear the order, filter on it (including `IS NULL` / `IS NOT NULL` in one click), fit
  the widths, and hide it — the spreadsheet's header menu, over a server-side query
- **The rows stay while the next page loads.** Sorting or filtering leaves what is on screen where
  it is, dimmed and inert, until the replacements arrive; a thin bar under the title bar carries the
  wait for the whole window
- **A tab keeps its page.** Picking another tab takes the browser down with it, so what a table tab
  was showing — its rows, its sort, its filters, the page it was on, even where it was scrolled to —
  is kept on the tab. Coming back draws it straight away and re-reads it *behind* the rows, with
  only a "Checking for changes…" beside the row count to say so. The answer reaches the grid only
  where it differs, so a table nobody has touched does not blink, and one that has changed updates
  in place. A table opened for the first time shows the wait from the first frame rather than
  flashing "No rows match" at it
- **Auto refresh, when you ask for it** — beside *Refresh*, a table can be set to re-read itself
  every 5, 10 or 30 seconds, every minute, or every 5 or 15 minutes, picked from a menu that hangs
  from the button in the window's own colours, with the interval in force ticked. It is *Off*
  when a table opens unless that table was last left refreshing — the interval is remembered per
  table (connection, database, schema and name) across restarts, and choosing *Off* forgets it.
  While it is open the choice belongs to the tab: a table left on a second screen to watch a queue drain
  keeps refreshing across a trip to another tab, into a split, or out into a window of its own,
  while every other table stays still. Each read is the same quiet re-read a reselected tab does —
  nothing dims, and only rows that actually changed are redrawn — and the next is timed from the
  end of the last, so a slow table is never asked twice at once. It waits while edits are staged
  (they are keyed by row position, and new rows under them would move them onto other rows), while
  a cell is being typed into, and while the connection is down; the control greys and says why. A
  read that fails turns it off and says so, rather than raising the same error every few seconds
- **The toolbar fits its pane.** A split, or a small window, takes the words off the secondary
  buttons — *Refresh*, *Auto*, *Filter*, *Columns*, *Row details*, *Add row* keep their icons,
  tooltips and names — and with edits staged the row count gives way first, so *Discard* and
  *Apply* are never pushed off the end
- **Row panel** beside the grid (`Ctrl+I`): the selected row as one field per line, with room for
  the values a 26px cell cannot show, editable in place and moving with the selection. The same
  panel sits beside query results, read-only, and "View row details" on any row's menu opens it
  there. It belongs to the tab, not to the window — two tables side by side in a split each show or
  hide their own fields, and the last choice made is how the next tab opens
- **A JSON document is shown as one.** SQL Server has no JSON type, so a document lives in an
  `nvarchar(max)` column and comes back as one long line. Where a field holds an object or an array,
  the row panel draws it as a tree instead — collapsible, two levels open to start with — and the
  field's own `{4}` / `raw` switch gives back the stored text, which is what editing edits. Only
  objects and arrays: a bare `42` or `"done"` is valid JSON too, and a tree of one line would say
  nothing the field did not
- **Follow a foreign key**: a `›` at the end of a referencing cell opens the referenced table in its
  own tab, filtered to the row it points at — composite keys included
- **Figures for the selected rows** — select two rows or more (Shift, Ctrl, or a drag) and the
  footer says what the focused column holds over them, the way a spreadsheet's status bar does:
  `amount · 12 rows on this page · Count 12 · Sum 4,310.50 · Avg 359.21 · Min 9.99 · Max 1,200.00`.
  A column that is not numeric gets its count and how many distinct values it has. NULLs are left
  out of the figures and counted on their own. They are over the rows that are loaded — a table's
  current page, staged edits included — and say so; query results show the same figures in their
  bar, over the rows that came back. See below

### Figures for the selected rows

They are worked out in the window from the rows it already has (`lib/selectionFigures.ts`), so
selecting costs nothing and the figures are only ever as wide as the page. The sums are done on
decimal digits, not floats: a `bigint` crosses from the main process as text so it keeps every digit,
and a `decimal` or `money` arrives as a number whose shortest text is the value the server holds, so
adding those as floats would turn `0.1 + 0.2` into `0.30000000000000004`. The sum, minimum and
maximum keep the column's places; the average has two at least. A `float` too fine to spell out
in digits is added as a float. A cell typed into but not applied is counted as what it now says,
and a numeric column with text typed into it is counted as text rather than added up wrongly.

### Following a foreign key

A cell in a column that references another table carries a small arrow. Clicking it opens the
referenced table filtered to that row, shows the filter that produced it, and puts the row straight
into the row panel:

```
sales.orders                          dbo.customers   WHERE customer_id = 2
┌────────────┬──────────────┬─────┐   ┌─────────────┬───────────────────┐
│ order_id   │ customer_id  │ …   │   │ customer_id │ email             │
│ 110        │ 2         ›  │ …   │ → │ 2           │ alan@example.com  │
└────────────┴──────────────┴─────┘   └─────────────┴───────────────────┘
```

Values travel as bound parameters, so the referenced row is found by an ordinary `WHERE`. Two shapes
have no conversion worth trusting — a NULL, and a binary key — and the arrow stays inert for them
rather than opening a query that would match nothing.

## Editing a table

- Edit cells in place — the editor grows past the cell for long or multi-line values, `Enter`
  commits, `Shift+Enter` adds a line, `Tab` moves on — or edit the same row from the row panel
- Insert rows, mark rows for deletion — all staged locally
- **Staged edits are never dropped without a word** — reloading, sorting, filtering or paging,
  picking another tab, switching to the table's structure, closing the tab, disconnecting, closing
  the window and quitting all stop and ask first: apply them, discard them, or stay where you are.
  The question says which of those it is
- One `Apply` sends the whole change set, executed **inside a transaction**: either all of it lands
  or none of it does
- **Apply shows the statements first** — every one it will send, in the order it sends them:
  deletes, then updates, then inserts. They are built from the same change set by the same builders
  the main process uses, so what is shown is what is sent; values are written in as literals to be
  read, while Apply still binds them as parameters. *Copy as script* puts the same statements on the
  clipboard as a script that runs on its own — `SET XACT_ABORT ON`, `BEGIN TRANSACTION` …
  `COMMIT TRANSACTION`, all or nothing like Apply — for a change ticket, or to repeat on another
  server. The focus starts on *Apply*, so Enter goes ahead and Escape doesn't. *Confirm before
  applying a change set* in Settings turns the review off; on a
  [confirm-writes](read-only.md#confirm-writes) connection it is always shown
- Rows are addressed by primary key; a keyless table falls back to matching every column and the UI
  says so — the review before Apply warns that such a statement may touch more than one row
- Identity and computed columns are excluded from inserts; `rowversion` is read-only
- **Import a CSV file, or paste a range from a spreadsheet** — rows arrive staged, like rows added
  by hand, and go up with Apply; see below

### Importing a CSV file

*Import* in the table's toolbar, *Import CSV…* on a table's menu in the tree, or a file dropped on
the rows opens the file in a dialog before anything happens to it:

- **Separated by** comma, semicolon, tab or pipe — worked out from the first lines, and changeable.
  Quoted fields may hold the separator, line breaks and doubled quotes. The file may be UTF-8 (with
  or without a byte-order mark), UTF-16 with one — Excel's *Unicode text* — or, failing UTF-8,
  Windows-1252, which is what Excel's plain CSV is on most Western machines.
- **The first row names the columns** — ticked when it names any of the table's, and then file
  columns are matched to table columns by name, ignoring case, spaces and underscores; without a
  header they are taken in order. Each table column picks its file column, or is left out and takes
  its default. Identity, computed and `rowversion` columns are not offered: the server fills them.
- **An empty cell is** NULL, or an empty string in a text column. An empty cell in a `NOT NULL`
  column with a default leaves the column out of that row, so it takes the default — an explicit
  NULL would not.
- **Every problem before anything is sent**, by line and column: a number that is not one, an
  integer out of its type's range, a decimal too large for its precision, a date that is not one,
  text longer than its column, a `NOT NULL` column left empty — and, once for the whole file, a
  required column nothing fills. The preview marks the cells.

*Stage* puts the rows that passed into the grid as staged inserts — the dialog says how many it
leaves out — to be looked over, edited and applied in one transaction like any other edit, or
discarded. Values are converted in the window (`shared/import.ts`) the way the server would
read them, and the ones that would lose digits as JS numbers — decimals, money, integers past
2^53 — and dates, which a time zone could move, go up as their text for SQL Server to convert.

**Thousands of rows** go up as multi-row `INSERT … VALUES (…), (…)` statements: consecutive inserts
into the same columns are gathered, as many to a statement as SQL Server takes (1000 rows, and
under its 2100 parameters), with every value still bound. A file of a few thousand rows is a few
statements, not one round trip a row, inside the same transaction — one bad row and none of them
land. The review before Apply shows the same statements, and *Copy as script* writes them out.

### Pasting from a spreadsheet

`Ctrl+V` with the grid focused pastes what is on the clipboard — a range copied from Excel or
Google Sheets arrives tab-separated, and a single value is a range of one — from the focused cell
across the columns on show and down the rows. Over rows that are there it stages updates; past the
last row it stages new rows; with nothing focused every line is a new row. A header row copied
with the range is recognised by its names and skipped, one value pasted over several selected rows
goes into each of them, and identity, computed and read-only columns are left as they are. Each
value is read as if it had been typed into its cell. A toast says how many rows changed and how
many were added; all of it is staged, so *Discard* takes it back. Neither works on a read-only
connection, any more than any other edit does.

## Structure and export

- Export result sets or whole tables to CSV, TSV, JSON, JSON Lines, SQL `INSERT`s or Markdown —
  with a live preview — to a file or the clipboard
- Structure tab: columns, indexes (including filtered and `INCLUDE`d), foreign keys in both
  directions, check/unique/default constraints, triggers, and a regenerated `CREATE TABLE` script
