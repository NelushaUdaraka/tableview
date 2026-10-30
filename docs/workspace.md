# The workspace

The window around your tabs: its title bar, its panes, the other windows beside it, and how it all
looks.

## One title bar

Window controls and the menu live in the same strip, VS Code style: the window is frameless on
Windows and Linux (inset on macOS, where the traffic lights stay put and the system menu bar keeps
the menus), and the renderer draws the menus, the document title and the minimise/maximise/close
buttons itself. The native menu is still installed and still owns every accelerator — the title bar
and it are built from one shared model in `src/shared/menu.ts`, so they cannot drift apart.

## Panes, and tabs that move between them

A tab can be put in a pane of its own beside the one it is in — `Ctrl+\`, the tab's own menu, or by
dragging it onto the other pane's strip — so two tables, or a query and its table, can be read at
once. Each pane has its own strip of tabs and its own tab showing; the pane you last clicked in is
the one `Ctrl+Enter` and `F5` act on. Splitting the only tab in a pane opens a second view of the
same thing rather than leaving an empty pane behind. `Ctrl+Shift+\` folds the split away, keeping
every tab.

Tabs drag: within a strip to reorder, onto the other strip to move pane, and **out of the window
entirely** — onto another window to move into it, or onto nothing at all to open in a window of
their own (also on the tab's menu, and File → Move Tab to New Window, which always opens a new one).
Nothing is carried across but a description of what to open — a window has its own connection pool,
so the one that takes the tab connects for itself, which needs the connection's password to be
saved, unless it already holds that connection and can simply show the tab. Staged edits stay with
the window they were made in: a tab that is holding them asks before it goes.

**A drag does not cross windows**, which is why the main process decides where one ends: a drag
event belongs to the document it started in, so the strip cannot be told it was dropped over another
window. What the renderer can say is where the pointer was — `screenX`/`screenY` at the end of the
drag — and the window manager turns that back into a window, taking the most recently focused of any
that cover the point, since raising a window is what focuses it. The window under it is sent the
tab; when there is none, a window is opened for it.

A window opened that way **is that one tab**: it opens onto the tab alone, with no schema tree
beside it, the way a dragged-out editor opens in a window of its own with none of the workbench
around it. The tree is not merely hidden, it is not built — though the schema behind it is still
read, so a query tab in that window still completes table and column names. `Ctrl+B` brings the
tree in for anyone who wants it, and it stays once it is there. Drag that tab back into the window
it came from and the empty frame goes with it: the window *was* the tab.

### A tab comes back as it was left

Only the tab showing in a pane is drawn; picking another takes it down until it is picked again,
which is what keeps a window with thirty tabs open as quick as one with two. What a tab was showing
is kept on the tab instead, and picking it again puts it back the way it was left:

- **a table** — the same page of rows, scrolled to the same rows and the same columns, each column
  as wide as it was, widened by hand or not; and its structure, scrolled where it was
- **a query** — the same text selected, the editor scrolled to the same line, and the results on
  the result set, the messages or the plan that was showing: a result set sorted the way it was and
  scrolled down and across to the same rows and columns, the messages to the same line
- **the activity monitor** — the sessions it last read, through the same filter, scrolled to the
  same place

**Nothing is read again unless the tab refreshes itself.** Rows written while a table was away stay
out of it until *Refresh* (`F5`): coming back is no reason to move rows under the reader. A table or
the monitor with auto refresh on is read straight away, since its timer stopped while it was away —
behind the rows, as its timer's reads are, and the rows stay scrolled where they were. A table
whose page was read in another database, the sidebar having switched while it was away, is read
again too: its next sort or page would read the database the sidebar is in now. A table's
structure is read afresh each time it is shown, as it always has been.

All of this lasts as long as the tab is in the window. A tab moved to another window, and the tabs
reopened after a restart, start afresh from the top and read what they show as they open.

## Quick open

`Ctrl+P` (View → Quick Open…) opens a box at the top of the window that finds any table, view,
procedure, function or saved query by name, from wherever you are — including a window holding one
dragged-out tab, which has no tree to find it in:

```
 ⌕ oi
 ▤ order_items         dbo                         5.4k rows
 ▤ orders              dbo                         1.2k rows
 ◉ v_order_totals      sales
 ↑↓ to move  Enter to open  Shift+Enter a table's structure  Esc to close
```

The letters typed only need to appear in order: a whole name comes first, then a name that starts
with them, then one whose words start with them (`oi` is `order_items`), then one that has them
together, then one that has them anywhere. Typing a dot matches the schema too (`sales.inv`).
With nothing typed it lists pinned tables, then what this window had on screen most recently,
then everything else. Each line shows the kind, the schema and a table's row estimate.

Enter opens a table's or view's rows, a routine's definition (as clicking it in the tree does) or a
saved query, tied to it so `Ctrl+S` saves it back — a saved query already open is shown where it is.
`Shift+Enter` (or `Ctrl+Enter`, or a click with either) opens a table's structure instead. Escape
closes it. Nothing is asked of the server: the names are the schema store's and the library's,
already read for the tree and the sidebar (`lib/quickOpen.ts` does the matching and ranking).

## Windows and connections

One connection is active per window, and **File → New Window** (`Ctrl+N`) opens as many as you like
— the intended way to work with several databases at once. Each window keeps its own connection,
tabs and schema tree; connections are namespaced per window, so two windows opening the *same* saved
connection get their own pool and tunnel rather than evicting one another. Closing a window closes
what it opened — once anything unsaved in it has been asked about. Saved connections and settings are shared, since one process owns those files.

## Toasts

What the app has to say arrives as a toast in the bottom-right corner, and puts itself away: a
notice after four seconds, an error after eight, since it usually has more to say. Resting the
pointer on a toast holds them all — not just that one, since a toast below it going would move it
out from under the pointer — and once the pointer leaves they count down again from the start. The
two that offer something to do, an update to restart into or to download, stay until they are taken
up or dismissed: a button that fades before it can be reached is no button at all.

## The layout, remembered

Where the workspace was left comes back after a restart: the sidebar's width, whether it was put
away (`Ctrl+B`), which of *Schema*, *Search*, *History* and *Saved* it shows, how tall the query editor is
above its results, each table's auto-refresh interval (see [tables](tables.md)), the tabs each
connection had open, and the database each was left in (below). None of this is
a setting — it is what the last drag or click left — so it lives in `ui-state.json` in the app's data
folder rather than in `settings.json`, and the Settings dialog does not list it.

A window opens with what is stored and writes back only what it changes, once a drag comes to rest
(and straight away as the window closes). The main process merges those writes, so two windows
remembering different tables keep both; for a size both windows change, the last one changed wins.
A window holding one dragged-out tab neither follows nor sets whether the sidebar is put away. The
file is read forgivingly: a missing or hand-broken value falls back to its default rather than
breaking the window, and the table intervals are capped at the 200 most recently set.

### Open tabs

Connecting to a connection reopens the tabs it had open the last time, restarts included: in the
same panes (a split comes back split), in the same order, with the same tab showing in each and the
same pane focused, in the database it was left in (below). A query tab comes back with its text and cursor, and is still tied to the saved
query it was opened from; a table tab with its view (rows or structure), its hidden columns, and
its auto-refresh interval. Nothing that was *read* comes back — results, pages of rows — and neither
does anything the app said would be lost: staged table edits, and a routine's unsaved changes (the
routine reopens at the definition it was last known to have). Closing every tab leaves nothing to
reopen, so the next connect opens one blank query, as a first one does.

Tabs are kept per saved connection, written as they change (with the same short pause), and only by
a full window: a window holding one dragged-out tab does not count. Disconnecting does not forget
them — that is exactly what the next connect brings back. Two full windows on the same connection
keep whichever changed last. Deleting a connection forgets its tabs, table intervals and database.

**Settings → Reopen a connection's tabs when connecting to it again** (on by default) switches this
off: nothing is reopened, nothing more is saved, and the tabs already kept are deleted from
`ui-state.json`. The main process enforces that, so a save already on its way when the box is
cleared is dropped too.

### The database you left it in

Switching database from the sidebar is remembered per connection, so connecting again opens in that
database — and its tabs reopen there — instead of in the one the connection's settings name.
Switching back to the settings' own database forgets it, as does deleting the connection. It is
not behind the *Reopen tabs* setting: it is where the connection is, not what was open in it.

The main process applies it while connecting, before the window is told the connection is open,
so the tree never reads the other database first. It connects as the settings say and then
switches, rather than logging in to the remembered database directly: SQL Server answers a login
to a database it will not open with "Login failed for user" — the driver keeps only the last of the
server's errors — which is also what a wrong password gets, so a retry could not tell the two apart
and would spend a second failed login on every mistyped password. Switching after the login has
worked has no such doubt. A switch the server refuses (the database was dropped, or this login can
no longer open it) leaves the connection where it was — the new pool is opened before the old one
is let go — so it stays in its own database, and the other is forgotten.

To remember something else, add a field to `UiState` in `src/shared/uiState.ts` (with its default
and how `normalizeUiState` reads it back), start the view from `useUiStateStore().state` and call
`remember({ field })` when it changes. The row panel's width predates this and stays in the settings.

## Themes, shortcuts and the look of it

- Dark and light themes (and "follow the system"), window state persistence, full menu bar and
  keyboard shortcuts (`Ctrl+/` lists them)
- **A calm, layered interface** — cool neutral grounds that step forward in lightness from the
  chrome to the content to anything floating, hairline borders, soft radii and one accent. Inter
  sets the interface and JetBrains Mono sets anything that is data or code; one SVG icon set
  replaces the typed glyphs that used to render differently on every platform. Menus, dialogs and
  toasts arrive with a short fade, and all of it stands still when the OS asks for reduced motion
- **Text boxes show exactly what was typed**: they draw no ligatures or contextual forms, which the
  SQL editor and the grid keep. Chromium reshapes only the part of a box's text that a keystroke
  changed, which parts a ligature from the glyph it depends on, so a typed `>=` showed as a blank
  and an `=`
