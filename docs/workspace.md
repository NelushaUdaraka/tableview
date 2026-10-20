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

## Themes, shortcuts and the look of it

- Dark and light themes (and "follow the system"), window state persistence, full menu bar and
  keyboard shortcuts (`Ctrl+/` lists them)
- **A calm, layered interface** — cool neutral grounds that step forward in lightness from the
  chrome to the content to anything floating, hairline borders, soft radii and one accent. Inter
  sets the interface and JetBrains Mono sets anything that is data or code; one SVG icon set
  replaces the typed glyphs that used to render differently on every platform. Menus, dialogs and
  toasts arrive with a short fade, and all of it stands still when the OS asks for reduced motion
