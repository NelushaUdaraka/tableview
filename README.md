# Beekeeper Clone

A cross-platform SQL client for **Microsoft SQL Server**, built with Electron, Vue 3 and
TypeScript. Phase 1 targets SQL Server as the only engine, but everything behind the
`DbClient` seam is written so a second engine slots in without touching the UI.

![Phase 1](https://img.shields.io/badge/phase-1-f0a91d) ![Engine](https://img.shields.io/badge/engine-SQL%20Server-blue)

---

## What's in phase 1

**Connections**
- Saved connections with name, colour tag, host/port, default database and a most-recently-used list
- SQL Server logins, Windows/NTLM (with domain), and Azure AD password auth
- TLS options: `encrypt`, `trustServerCertificate`, named instances, `ApplicationIntent=ReadOnly`,
  connect/request timeouts, pool sizing, application name
- **SSH tunnelling** with password, private key (with passphrase) or agent auth, `~` expansion,
  keepalives, and an ephemeral loopback-only local port
- **AWS SSM Session Manager** port forwarding — the app runs `aws ssm start-session` for you and
  points the connection at the port it opens, so there is no second terminal to babysit (see below)
- **Bastion picked from the account, not remembered** — paste credentials, choose a region, and the
  connection form lists the instances in it with their Name tags and whether Systems Manager can
  actually reach them
- Passwords and SSH secrets encrypted at rest — the OS keystore via Electron `safeStorage` where
  available, AES-256-GCM under a `0600` key file otherwise. Secrets never reach the renderer.
- Test-connection button that reports the server edition and version
- **Kept alive, and put back when it drops** — an idle connection is poked once a minute (the
  *Keepalive* option; 0 turns it off) so an SSM session, an SSH forward or a firewall does not tear
  it down for want of traffic. A connection that goes anyway is reopened in the background with a
  backoff, for about eight minutes; the status bar says what is happening and offers *Reconnect*
  once it stops trying. Credentials that have run out and a login the server refuses are not retried
  at all — neither is going to fix itself. The window keeps its tabs and staged edits throughout.

**Connecting through an AWS bastion (SSM)**

Pick *AWS SSM* on the connection's Tunnel tab instead of running the CLI by hand. The session starts
when you connect and is torn down when you disconnect — including the `session-manager-plugin`
grandchild, which on Windows has to be killed as a process tree or it keeps holding the local port.

- **Forward to a remote host** — the bastion relays to an RDS endpoint or another internal listener.
  Uses `AWS-StartPortForwardingSessionToRemoteHost`; the Server field is resolved *from the bastion*.
- **Forward to the instance itself** — SQL Server runs on the bastion. Uses
  `AWS-StartPortForwardingSession`.

**Picking the bastion.** An instance ID is not a durable setting: a redeploy replaces the bastion
and the saved ID quietly points at something that no longer exists. So once the credentials are in
place and a region is chosen, **Fetch instances** lists what is actually there and the ID becomes a
choice from a list:

```
prod-bastion — i-0ba5711000fee1dad · running · 10.0.2.11 · SSM Online
old-bastion  — i-0dead00beef001122 · running · 10.0.2.12 · SSM ConnectionLost
app-server   — i-0abc123def4567890 · running · 10.0.3.40 · not in SSM
```

Two calls stand behind it — `ec2 describe-instances` for what exists, with Name tags and state, and
`ssm describe-instance-information` for what Session Manager can reach, which is what decides
whether a session can start at all. The reachable ones sort first, `mi-` managed instances that are
not EC2 are included, and either call being denied by IAM degrades to the other's list with a note
rather than to nothing. Reopen a saved connection, fetch, and an ID the region no longer knows about
is called out as replaced.

The list is per region, so the region field is the one that has to be right; it is prefilled from
the pasted block when that names one. You can still type an ID by hand — the field stays editable,
and the picker only fills it in.

Set a fixed local port (blank picks a free one) and an explicit CLI path if you need them.
**Check prerequisites** verifies the three things that actually go wrong — the AWS CLI, the Session
Manager plugin, and whether your credentials are still valid — and `aws sts get-caller-identity`
confirms which identity you are about to connect as.

**Credentials.** Two sources, chosen per connection:

- **Paste them into the app** (the default). Copy the block straight out of the AWS access portal
  and paste it in — bash `export`, PowerShell `$Env:`, cmd `set`, or a credentials-file stanza are
  all accepted, quotes and stray semicolons included. The block is **saved with that connection**,
  encrypted by the same vault that protects database passwords, so connections in different AWS
  accounts each carry their own. Re-paste when they expire.
- **Let the AWS CLI resolve them** — the normal chain: `--profile`, environment variables, SSO
  cache, `credential_process`, assume-role, instance profile. Use this if you keep profiles in
  `~/.aws/`.

Only a masked summary (`ASIA****…MPLE · eu-west-2 · temporary`) ever reaches the renderer; the
secret and session token stay in the main process. The app never *derives* credentials: it either
passes through what you pasted, as environment variables on the CLI child, or stays out of the way
entirely. Pasted credentials take precedence over anything inherited, so a stale `AWS_PROFILE` in
the app's environment cannot quietly win, and `--profile` is suppressed for them.

Failures are translated rather than passed through: a missing plugin, `TargetNotConnected`, an IAM
denial, an expired SSO session, a bad profile or a busy port each produce a specific instruction
instead of an exit code.

**A destination the session cannot reach** is the one failure that does not announce itself at
startup. Session Manager binds the local port before anything is dialled at the far end, so a
bastion without SQL Server on it, or an RDS endpoint its security group will not let it reach, looks
like a healthy session until the first byte moves — and then the driver reports nothing but
`Connection lost - socket hang up`. So the CLI's output is watched for the whole life of the session,
not just at exit (`Connection to destination port failed`, `Unable to dial connection to port`), the
message is given a moment to arrive after the driver has already given up, and the advice names the
topology in use: the remote host and its security group, the "Forward to" setting when the port was
dialled on the bastion itself, or — for a relayed `localhost`, which the *bastion* resolves and so
forwards to itself — the Server field. The connection form flags that last one before you connect. A drop the CLI never explains says so plainly rather than passing
on the driver's wording.

Readiness comes from the plugin's own `Waiting for connections` banner rather than a probe
connection, because `AWS-StartPortForwardingSession` carries one client at a time and a probe that
connects and hangs up can leave the far side torn down for the connection that follows.

Requires AWS CLI v2 and the Session Manager plugin on the machine running the app, and
`ssm:StartSession` permission on the instance and the port-forwarding document. The instance picker
additionally uses `ec2:DescribeInstances` and `ssm:DescribeInstanceInformation`; neither is needed to
connect, and holding only one of them still produces a usable list.

**Schema explorer**
- Database switcher (system databases hidden by default), schema/table/view/procedure/function tree
- Row-count estimates, live filter box, pinned tables, per-schema collapse
- Context menu: open data, open structure, generate `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`CREATE TABLE`,
  copy qualified name, show routine definition, truncate, drop

**Table browser**
- Virtualised grid — only visible rows are rendered, so large results scroll smoothly
- Server-side paging, multi-column sorting (shift-click to add a key)
- Filter builder (16 operators, AND/OR) and a raw `WHERE` mode; values are always **bound
  parameters**, and `contains`/`starts with`/`ends with` escape LIKE wildcards
- Column resize by drag, double-click a divider to fit
- **Right-click a column header** for what can be done to that column: sort either way, add it to
  the sort, clear the order, filter on it (including `IS NULL` / `IS NOT NULL` in one click), and
  fit the widths — the spreadsheet's header menu, over a server-side query
- **The rows stay while the next page loads.** Sorting or filtering leaves what is on screen where
  it is, dimmed and inert, until the replacements arrive; a thin bar under the title bar carries the
  wait for the whole window
- **Row panel** beside the grid (`Ctrl+I`): the selected row as one field per line, with room for
  the values a 26px cell cannot show, editable in place and moving with the selection. The same
  panel sits beside query results, read-only, and "View row details" on any row's menu opens it
  there. It belongs to the tab, not to the window — two tables side by side in a split each show or
  hide their own fields, and the last choice made is how the next tab opens
- **Follow a foreign key**: a `›` at the end of a referencing cell opens the referenced table in its
  own tab, filtered to the row it points at — composite keys included

**Following a foreign key**

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

**Table editing**
- Edit cells in place — the editor grows past the cell for long or multi-line values, `Enter`
  commits, `Shift+Enter` adds a line, `Tab` moves on — or edit the same row from the row panel
- Insert rows, mark rows for deletion — all staged locally
- One `Apply` sends the whole change set, executed **inside a transaction**: either all of it lands
  or none of it does
- Rows are addressed by primary key; a keyless table falls back to matching every column and the UI
  says so
- Identity and computed columns are excluded from inserts; `rowversion` is read-only

**Query editor**
- CodeMirror 6 with T-SQL highlighting and schema-aware completion pulled from the live database
- Run all / run selection / run the statement under the cursor; cancel a running query
- Scripts split on `GO` (like SSMS), so `BEGIN … END` bodies and `CREATE PROCEDURE` work; `GO 5` repeats
- Multiple result sets per batch, rows-affected, `PRINT` output, and errors with their
  message number, state and line
- Results sort by clicking a header — a local reorder, since the statement is yours to re-issue, not
  ours to rewrite — with NULLs kept at the end either way
- SQL formatting, open/save `.sql` files, saved queries, searchable query history

**One title bar**

Window controls and the menu live in the same strip, VS Code style: the window is frameless on
Windows and Linux (inset on macOS, where the traffic lights stay put and the system menu bar keeps
the menus), and the renderer draws the menus, the document title and the minimise/maximise/close
buttons itself. The native menu is still installed and still owns every accelerator — the title bar
and it are built from one shared model in `src/shared/menu.ts`, so they cannot drift apart.

**Panes, and tabs that move between them**

A tab can be put in a pane of its own beside the one it is in — `Ctrl+\`, the tab's own menu, or by
dragging it onto the other pane's strip — so two tables, or a query and its table, can be read at
once. Each pane has its own strip of tabs and its own tab showing; the pane you last clicked in is
the one `Ctrl+Enter` and `F5` act on. Splitting the only tab in a pane opens a second view of the
same thing rather than leaving an empty pane behind. `Ctrl+Shift+\` folds the split away, keeping
every tab.

Tabs drag: within a strip to reorder, onto the other strip to move pane, and **out of the window
entirely** to open in a window of their own (also on the tab's menu, and File → Move Tab to New
Window). Nothing is carried across but a description of what to open — the new window has its own
connection pool, so it connects for itself, which needs the connection's password to be saved.
Staged edits stay with the window they were made in: a tab that is holding them asks before it goes.

A window opened that way **is that one tab**: it opens onto the tab alone, with no schema tree
beside it, the way a dragged-out editor opens in a window of its own with none of the workbench
around it. The tree is not merely hidden, it is not built — though the schema behind it is still
read, so a query tab in that window still completes table and column names. `Ctrl+B` brings the
tree in for anyone who wants it, and it stays once it is there.

**Windows and connections**

One connection is active per window, and **File → New Window** (`Ctrl+N`) opens as many as you like
— the intended way to work with several databases at once. Each window keeps its own connection,
tabs and schema tree; connections are namespaced per window, so two windows opening the *same* saved
connection get their own pool and tunnel rather than evicting one another. Closing a window closes
what it opened. Saved connections and settings are shared, since one process owns those files.

**Everything else**
- Export result sets or whole tables to CSV, TSV, JSON, JSON Lines, SQL `INSERT`s or Markdown —
  with a live preview — to a file or the clipboard
- Structure tab: columns, indexes (including filtered and `INCLUDE`d), foreign keys in both
  directions, check/unique/default constraints, triggers, and a regenerated `CREATE TABLE` script
- Dark and light themes (and "follow the system"), window state persistence, full menu bar and
  keyboard shortcuts (`Ctrl+/` lists them)

---

## Getting started

```bash
npm install
npm run dev          # hot-reloading dev build
```

### If `npm run dev` says "Electron uninstall"

Electron 44 has no postinstall hook — it exposes an `install-electron` bin and otherwise fetches its
binary lazily on first launch. electron-vite reads `node_modules/electron/path.txt` directly, so it
never triggers that lazy fetch and fails instead. The `postinstall` script in `package.json` runs the
installer for you; if you installed with `--ignore-scripts`, or the download was blocked, run it by
hand:

```bash
npx install-electron
```

That downloads roughly 100 MB from GitHub releases and writes `path.txt`. Behind a proxy or a
mirror, point it somewhere reachable first:

```bash
# a mirror
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npx install-electron

# or an already-downloaded, unzipped build
set ELECTRON_OVERRIDE_DIST_PATH=C:\path\to\electron-v44.1.1-win32-x64
```

### Build for Windows

The whole production dependency tree is **pure JavaScript** — no native modules — so there is no
node-gyp step and nothing to rebuild per platform.

On a Windows machine:

```bash
npm install
npm run build:win
```

That produces, in `release/<version>/`:

| Artifact | What it is |
| --- | --- |
| `Beekeeper Clone-0.1.0-x64.exe` | NSIS installer (per-user, choosable install directory, shortcuts) |
| `Beekeeper Clone-0.1.0-portable.exe` | Single-file portable build |

Builds are unsigned by default. To sign, set `CSC_LINK` (path or base64 of a `.pfx`) and
`CSC_KEY_PASSWORD` before running — electron-builder picks them up automatically.

`npm run build:linux` and `npm run build:unpack` are also available; the latter produces an
unpacked directory, which is the quickest way to sanity-check packaging.

---

## Testing

Three layers, all runnable on Linux:

| Command | What it covers |
| --- | --- |
| `npm test` | 411 unit tests — SQL building, T-SQL lexing, value serialisation, exporters, credential vault, storage, driver config |
| `npm run test:integration` | 66 tests against a **real SQL Server 2022** and a **real sshd** |
| `npm run test:e2e` | Boots the actual Electron app and drives the UI over the DevTools protocol |

### Bringing up the test environment

```bash
scripts/test-env.sh up      # SQL Server on :11433, sshd on :2222
npm run test:integration
scripts/test-env.sh down
```

The script also generates the SSH keypairs the tunnel tests use (one plain, one passphrase-protected)
and flips `AllowTcpForwarding` on, which the `linuxserver/openssh-server` image ships disabled.

### End-to-end

```bash
scripts/e2e.sh all          # or: smoke | workspace | editing | table-ui | ssm-form
```

On a headless box it starts Xvfb itself. It needs Electron's usual Linux libraries:

```bash
apt-get install -y xvfb libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2t64 libnss3 libnspr4 libgtk-3-0t64 libatspi2.0-0t64
```

The suites:
- **smoke** — the window opens, the preload bridge exposes the API, settings load, IPC errors arrive
  as real `Error`s, and a saved password never appears in renderer-visible data
- **workspace** — connects to the container, loads the schema tree, opens a table, reads the grid,
  checks the structure tab, types and runs a JOIN in the editor, provokes a SQL error, toggles theme
- **editing** — edits a cell, stages an insert, applies the change set, verifies the rows in the
  database, deletes through the context menu, and drives the filter builder
- **table-ui** — opens the title bar's View menu, reads the selected row out of the row panel, edits
  a field there and applies it to the database, follows a foreign key into the referenced table and
  checks the filter and the row it lands on, opens the expanding cell editor, and hides the panel
- **ssm-form** — drives the tunnel picker, validates the instance ID, pastes a credentials block,
  fetches the account's instances and picks the bastion from the list (including the empty answer a
  wrong region gives), runs the prerequisite check in both its failing and passing states, saves,
  reopens the connection to confirm the stored summary appears while the secret never reaches the
  renderer, and opens a second window. `scripts/e2e.sh` writes stand-ins for `aws` and
  `session-manager-plugin` into `.tmp/bin`, so it needs no AWS account.

Screenshots land in `.tmp/`.

---

## Architecture

```
src/
├── main/                     Electron main process
│   ├── db/
│   │   ├── registry.ts       live client per connection
│   │   └── sqlserver/        client, config mapping, catalog queries, type mapping
│   ├── tunnel/               ssh.ts, ssm.ts (AWS Session Manager), ec2Instances.ts
│   │                         (the bastion picker's lookup), shared contract
│   ├── storage/              JSON stores + credential vault
│   ├── ipc/                  handlers, each wrapped in a result envelope
│   ├── menu.ts, window.ts    native menu + roles, frameless windows and their state
│   └── index.ts
├── preload/index.ts          contextBridge façade
├── shared/                   used by both sides
│   ├── types.ts              the IPC contract
│   ├── menu.ts               the menu model the native menu and title bar share
│   ├── foreignKeys.ts        which cells carry an arrow, and what it filters on
│   ├── aws/credentials.ts    parses the AWS portal's credential blocks
│   ├── aws/regions.ts        the region list the connection form offers
│   ├── sql/                  identifier escaping, T-SQL lexer, query builders
│   ├── serialize.ts          driver values ⇄ IPC-safe cell values
│   ├── export.ts             CSV/JSON/SQL/Markdown
│   └── ipcSerialize.ts       strips Vue proxies before they hit contextBridge
└── renderer/src/             Vue 3 + Pinia
    ├── lib/api.ts            the only place that touches window.api
    ├── lib/menuBus.ts        menu actions, whichever menu raised them
    ├── stores/               connections, schema, tabs (and panes), library,
    │                         settings, toasts, busy (the window's progress bar)
    ├── components/           title bar, grid, row panel, editor, sidebar, dialogs
    └── views/                connection screen, workspace, pane, query, table
```

A few decisions worth knowing about:

**`src/main/db/**` never imports Electron.** That is what lets the integration tests drive the real
client directly against a container, with no app running.

**Values are bound, identifiers are quoted.** `src/shared/sql/identifiers.ts` is the only module
allowed to interpolate into SQL text, and it only ever receives identifiers. Everything a user types
becomes a parameter. The one deliberate exception is the raw `WHERE` box, where the user is
explicitly writing SQL.

**Scripts split on `GO`, not `;`.** A semicolon terminates a statement *inside* a batch, so splitting
on it would cut `BEGIN … END` bodies in half. `splitStatements` (which does split on `;`) exists only
for editor conveniences like "run the statement under the cursor".

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

**The renderer converts reactive state to plain data before the bridge.** `contextBridge` clones
arguments with the structured clone algorithm, which refuses to clone a Proxy — which is exactly
what Vue reactive state is. `lib/api.ts` handles this once for every call site.

---

## Known limitations

Deliberately out of scope for phase 1, in rough priority order for phase 2:

- **One engine.** Only SQL Server. The `DbClient` seam is in place but there is no second driver.
- **One connection per window.** Several windows work, and a window can show two panes side by side,
  but both panes talk to the same connection — the schema store is keyed for one connection at a
  time. Two connections at once means two windows.
- **Two panes, not more.** A tab can be split off into a second pane; there is no third, and no
  stacking panes vertically.
- **No schema editing UI.** You can drop and truncate from the sidebar and run any DDL you like in
  the editor, but there is no visual "add column" / "create index" builder.
- **No backup/restore, import, or diff tooling.**
- **Confirmations use native `window.confirm`.** Functional, but it blocks the renderer and does not
  match the app's styling; an in-app modal would be better.
- **Named instances cannot be used through an SSH tunnel** — SQL Browser resolves them over UDP 1434,
  which a TCP forward cannot carry. Give an explicit port instead. The app ignores `instanceName`
  when tunnelling rather than failing confusingly.
- **Azure AD support is password-flow only** — no interactive, device-code or managed-identity flows.
- **A dropped connection is reopened, not resumed.** The keepalive keeps an idle session from being
  torn down, and a connection that goes anyway is reopened in the background — but reopening means a
  fresh SSM session and a fresh pool, so anything that was in flight is lost and has to be re-run.
  Credentials that ran out are not something reopening can fix; the status bar says so and offers
  the paste box.
- **No interactive AWS prompts.** The CLI child is spawned without stdin, so a profile configured
  with `mfa_serial` cannot be answered, and `aws sso login` (a browser flow) has to be run yourself —
  the app detects the expiry and says so. Pasting portal credentials sidesteps both.
- **Expiry is only known when the block says so.** The portal's environment-variable format carries
  no expiry, so the app can tell you the credentials *are* temporary but not when they lapse; it
  reports the failure when they do.
- **The bastion is still stored as an instance ID.** The picker resolves Name tags at the moment you
  fetch, but what the connection saves is the ID it produced, so a redeploy still means fetching the
  list again and picking the new instance — the form tells you when the saved ID has gone.
- **The renderer bundle is ~1.7 MB** (CodeMirror and the SQL formatter dominate). Fine for a desktop
  app; worth code-splitting if startup time ever matters.
- **Query results are capped** at `maxResultRows` (50 000 by default). Rows past the cap are counted
  but not retained, and the results header says so.

## Licence

MIT
