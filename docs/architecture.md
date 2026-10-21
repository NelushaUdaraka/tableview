# Architecture

Phase 1 targets SQL Server as the only engine, but everything behind the `DbClient` seam
(`src/main/db/types.ts`) is written so a second engine slots in without touching the UI.

## Source layout

```
src/
├── main/                     Electron main process
│   ├── db/
│   │   ├── registry.ts       live client per connection
│   │   └── sqlserver/        client, config mapping, catalog queries, type mapping, and
│   │                         session.ts — a query tab's own connection to the server
│   ├── tunnel/               ssh.ts, ssm.ts (AWS Session Manager), ec2Instances.ts
│   │                         (the bastion picker's lookup, and the name a
│   │                         connection resolves on connect), shared contract
│   ├── storage/              JSON stores + credential vault
│   ├── ipc/                  handlers, each wrapped in a result envelope
│   ├── menu.ts, window.ts    native menu + roles, frameless windows and their state
│   ├── closeGuard.ts         holds a window's close, and the quit, while it has unsaved work
│   ├── updater.ts            when to look for a release and what to do with one;
│   │                         electron-updater does the fetching and installing
│   └── index.ts
├── preload/index.ts          contextBridge façade
├── shared/                   used by both sides
│   ├── types.ts              the IPC contract
│   ├── menu.ts               the menu model the native menu and title bar share
│   ├── foreignKeys.ts        which cells carry an arrow, and what it filters on
│   ├── aws/credentials.ts    parses the AWS portal's credential blocks
│   ├── aws/regions.ts        the region list the connection form offers
│   ├── accent.ts             a connection's colour, and the shades derived from it
│   ├── copyName.ts           what a duplicated connection is called
│   ├── connectionTransfer.ts the connection export file, and what it leaves out
│   ├── tableplus.ts          a connection copied out of TablePlus as a URL, and what it fills in
│   ├── sql/                  identifier escaping, T-SQL lexer, query builders, and
│   │                         readOnly.ts — what a read-only connection refuses to send
│   ├── sessions.ts           a query tab's session: when it follows the sidebar, when a run
│   │                         after losing one is refused, and what the tab says
│   ├── serialize.ts          driver values ⇄ IPC-safe cell values
│   ├── export.ts             CSV/JSON/SQL/Markdown
│   ├── updates.ts            the update state both sides share, and where releases live
│   └── ipcSerialize.ts       strips Vue proxies before they hit contextBridge
└── renderer/src/             Vue 3 + Pinia
    ├── lib/api.ts            the only place that touches window.api
    ├── lib/menuBus.ts        menu actions, whichever menu raised them
    ├── lib/schemaTree.ts     a table's structure as the sidebar tree shows it
    ├── lib/jsonCell.ts       which cells hold a document, and what is inside one
    ├── lib/tableCache.ts     the page a table tab keeps, and what counts as it changing
    ├── lib/autoRefresh.ts    a table re-reading itself: the intervals, and what holds a read back
    ├── lib/columnVisibility.ts which columns a table's grid shows, and the page cut down to them
    ├── lib/tableFilters.ts   whether a table read goes through a filter, as the main process decides
    ├── lib/lineDiff.ts       what differs from a routine's stored definition, and putting one change back
    ├── lib/changeTracking.ts the editor's change marks, the peek under a change, and its revert
    ├── lib/runQueryTab.ts    runs a query tab, on screen or not, and says whether it saved a routine
    ├── lib/tabSessions.ts    ending a tab's session, and stopping the query running on it
    ├── lib/sortConnections.ts the orders the connection list can be read in
    ├── lib/updateStatus.ts   the Settings line about updating, and the one button beside it
    ├── lib/connectionGroups.ts the headings the list is filed under
    ├── lib/icons.ts          the one icon set, drawn by components/AppIcon.vue
    ├── lib/modalStack.ts     which open dialog Escape belongs to
    ├── styles/index.css      design tokens for both themes, and the shared controls
    ├── stores/               connections, schema, tabs (and panes), library,
    │                         settings, toasts, busy (the window's progress bar),
    │                         read-only (the question before one may write again),
    │                         updates (what a window says about a new release)
    ├── components/           title bar, grid, row panel (and its JSON tree),
    │                         editor, sidebar (and its structure tree), dialogs
    │                         (OpenTransactionDialog: the question before a tab's
    │                         transaction would end), the toolbar's drop-down panels
    │                         (a choice menu, the column picker)
    └── views/                connection screen, workspace, pane, query, table
```

## Decisions worth knowing about

**`src/main/db/**` never imports Electron.** That is what lets the integration tests drive the real
client directly against a container, with no app running.

**Values are bound, identifiers are quoted.** `src/shared/sql/identifiers.ts` is the only module
allowed to interpolate into SQL text, and it only ever receives identifiers. Everything a user types
becomes a parameter. The one deliberate exception is the raw `WHERE` box, where the user is
explicitly writing SQL.

**Scripts split on `GO`, not `;`.** A semicolon terminates a statement *inside* a batch, so splitting
on it would cut `BEGIN … END` bodies in half. `splitStatements` (which does split on `;`) exists only
for editor conveniences like "run the statement under the cursor".

**A query tab has a session of its own; everything else shares the pool.** The window's pool
hands back the most recently released connection, never resets one between uses, and closes any
left idle for thirty seconds. That suits the app's own reads, which ask for nothing to last, and
does not suit a script, whose temp tables, settings, `USE` and transactions are meant to be there
for the next run and nowhere else. Run on the pool, a `USE` in one tab sent the table tabs and the
tree to another database, and a transaction left open became part of whatever borrowed its
connection next, until the pool closed the connection and the server rolled the work back. So each
query tab holds a connection of its own (`QuerySession`), opened on its first run and closed with
the tab, while the tree, the table tabs, completion and the heartbeat keep to the pool.

A session's connection is never replaced behind the tab's back. mssql checks a pooled connection
before handing it out and quietly swaps a dead one for a fresh one; for a session that would run the
next script with none of what the last one set up — or commit, statement by statement, work that
was meant to stay inside a transaction. So the session's pool has validation off, sees every
connection it makes through `beforeConnect`, closes any after the first, and reports the session
lost; whether the tab's next run may go ahead on a new session is decided knowing what the old one
held.

**Cell values are tagged across IPC.** Dates, binary and bigints do not survive structured clone
with their identity intact, so they cross as `{ t: 'date' | 'bytes' | 'bigint' | 'json', v: … }` and
round-trip back when a row is written. `bigint` stays textual so precision beyond 2^53 is not lost.

**The menu is described once and rendered twice.** `src/shared/menu.ts` holds the model; the main
process turns it into an Electron `Menu` (which macOS shows and which supplies the accelerators on
every platform) and the title bar draws the same items in the window. Items the renderer cannot
carry out itself — clipboard, zoom, dev tools, closing the window — name an Electron role and come
back over IPC.

**App data is written new-file-then-rename, and the rename retries.** A crash mid-write then leaves
the previous copy intact rather than half of the new one. On Windows that rename is not guaranteed
to go through first time — a virus scanner or the search indexer holding either file open comes back
`EPERM` — so `JsonStore` retries, and falls back to writing over the file directly. Window geometry
takes the same route but is also *coalesced*: dragging a window's edge raises `resize` dozens of
times a second, and one write per event is both wasted work and the surest way to meet that lock.
One write per burst, one more when the window closes, and a geometry write that cannot be made is
logged rather than thrown — it is not worth failing the app over.

**A tab belongs to a pane, and only a pane's active tab is mounted.** The tab store holds one flat
list of tabs and one or two panes naming which of them they hold. Because only the mounted tab can be
holding staged edits, the view that owns them registers a leave guard *against its own tab id*, and
everything that would unmount a view — selecting another tab, closing one, moving it to the other
pane, folding the split away, dragging it into a new window — asks the tabs that are about to go.
The split pane is always rendered, collapsed rather than replaced when there is no second pane:
swapping between two layouts would remount the first pane's view and take its staged edits with it.

**A table tab keeps its last page, and re-reads it behind the rows.** Unmounting a view takes
everything it was holding with it, so reselecting a tab used to mean an empty grid and a spinner for
as long as the server took — to arrive at the rows it had a second earlier. The page it last drew is
kept on the tab instead (`markRaw`, like a query tab's result, so a page of rows stays out of the
reactivity graph), and the view is seeded from it during setup, before its first render. What
follows is an ordinary read marked `background`: nothing is dimmed and nothing is blocked, and
`lib/tableCache.ts` compares the answer against what is drawn so that only a real difference reaches
the grid — handing it new columns resets the widths and the selection, and new rows lose the scroll
position, which is a poor way to say "nothing has changed". Loads carry a token for the same reason:
the reader can sort, filter or page while that read is in flight, and the last thing asked for is
the one whose answer counts.

**The renderer converts reactive state to plain data before the bridge.** `contextBridge` clones
arguments with the structured clone algorithm, which refuses to clone a Proxy — which is exactly
what Vue reactive state is. `lib/api.ts` handles this once for every call site.
