# Development

Running TableView from source, building its packages, and testing it. Cutting a release has
[a page of its own](releasing.md), and [Architecture](architecture.md) explains how the code is laid
out.

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

## Build for Windows

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
| `TableView-0.1.0-windows-x64-setup.exe` | NSIS installer (per-user, choosable install directory, shortcuts) — the copy that updates itself |
| `TableView-0.1.0-windows-x64-portable.exe` | Single-file portable build |
| `latest.yml`, `TableView-0.1.0-windows-x64-setup.exe.blockmap` | What an installed copy reads to update: the newest version and its checksum, and the block map that lets it download only what changed |

Every file is named for the system it runs on, then the processor, so the Windows and Linux files
of a release sit apart on its page. The names come from `artifactName` in `electron-builder.yml`.
Installed copies find their update through `latest.yml`, not by name, so a rename does not stop them
updating. It does cost the next Windows update its download of only what changed: that looks for the
previous release's block map under the new name, finds none, and downloads the whole installer.

Builds are unsigned by default. To sign, set `CSC_LINK` (path or base64 of a `.pfx`) and
`CSC_KEY_PASSWORD` before running — electron-builder picks them up automatically.

`npm run build:unpack` produces an unpacked directory instead, which is the quickest way to
sanity-check packaging. No build script publishes anything: uploading takes `--publish`, which only
the release workflow passes.

## Build for Linux

On a Linux machine:

```bash
npm install
npm run build:linux
```

That produces, in `release/<version>/`, for both x64 and arm64 — one x64 machine builds both, since
there is nothing native to compile:

| Artifact | What it is |
| --- | --- |
| `TableView-0.1.0-linux-x86_64.AppImage`, `TableView-0.1.0-linux-arm64.AppImage` | Runs on most distributions without installing: mark it executable and open it. The copy that updates itself |
| `TableView-0.1.0-linux-amd64.deb`, `TableView-0.1.0-linux-arm64.deb` | Installs into `/opt/TableView` with a menu entry, for Debian, Ubuntu and their relatives |
| `latest-linux.yml`, `latest-linux-arm64.yml` | What an AppImage reads to update, and a .deb to say there is a newer one |

`x86_64` and `amd64` are the AppImage's and Debian's names for the same 64-bit Intel and AMD
processors — Windows calls them `x64`; `arm64` is for ARM machines.

The AppImages use electron-builder's static AppImage runtime (`toolsets.appimage` in
`electron-builder.yml`), which mounts with the FUSE 3 that desktop distributions already install.
electron-builder's default runtime wants libfuse2, which Ubuntu stopped installing with 22.04, so an
AppImage built with it does not even open on a fresh Ubuntu. Where FUSE is missing altogether — some
containers and minimal installs — run the AppImage with `--appimage-extract-and-run`.

## Testing

Three layers, all runnable on Linux:

| Command | What it covers |
| --- | --- |
| `npm test` | 1165 unit tests — SQL building, T-SQL lexing, the read-only check and what confirm writes lists, the statements Apply shows, value serialisation, exporters, credential vault, storage, driver config, a routine's change tracking, auto refresh, the columns a table shows, TablePlus URLs, when the app updates itself |
| `npm run test:integration` | 72 tests against a **real SQL Server 2022** and a **real sshd** |
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
scripts/e2e.sh all          # or: smoke | connections | workspace | editing | editor | table-ui | table-tools | routines | auto-refresh | unsaved | read-only | confirm-writes | certificate | workbench | ssm-form | ssm-sso
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
- **connections** — duplicates a saved connection from the list and from inside the form, checks
  the copy opens ready to edit with the secrets carried over, that the original comes through
  untouched either way, and that a copy of a copy is numbered rather than suffixed twice; that
  *Delete* in a row's ⋮ asks in the app, Cancel focused, and Cancel keeps the connection. Then
  the TablePlus import: the ⋮ menu's *Import from TablePlus…* opens a new connection with its
  steps showing and editing one shows no panel; a paste of anything but a SQL Server URL from
  TablePlus leaves the form as it was, and the real one replaces every field — the password
  masked, the colour and group mapped — and saves with the password stored but never handed back
  to the window; the same URL again is called out and saved beside the first, which is
  untouched, a URL with no password stores none, and a key tunnel asks for its file. Needs no
  database: nothing in it connects.
- **workspace** — connects to the container, loads the schema tree, opens a table, reads the grid,
  checks the structure tab, types and runs a JOIN in the editor, provokes a SQL error, toggles theme
- **editing** — edits a cell, stages an insert, checks the review before Apply lists the `UPDATE`
  and the `INSERT` with their values, in that order, with the focus on *Apply* and *Copy as script*
  beside it; applies the change set, verifies the rows in the database, deletes through the context
  menu (the review shows the `DELETE`), and drives the filter builder
- **editor** — completion in a query tab: a bare word offers the columns of the table the `FROM`
  after it names, first and with the table beside them; `c.` offers only the alias's table's
  columns, keywords left out; a bracketed table's column is inserted in brackets; and after `FROM`
  tables come without columns. The starter `tran` snippet is first for `tran`, shows its preview,
  and goes in with its placeholder selected. The Snippets dialog (Query menu) lists the starters,
  turns down a snippet with no prefix, and saves one; typing its prefix inserts it, and Tab moves
  from its first placeholder to its second
- **table-ui** — opens the title bar's View menu, reads the selected row out of the row panel, edits
  a field there and applies it to the database, follows a foreign key into the referenced table and
  checks the filter and the row it lands on, opens the expanding cell editor, and hides the panel
- **table-tools** — opens the columns picker and checks it hangs from its button with every column
  ticked; hides a column and checks it goes at once without the table being read (a row written
  from outside stays out); narrows the list with a search and hides what matches; hides a column
  from the header menu, and checks the arrow keys step over it, the row panel leaves it out and a
  copied row is the columns on show; takes the tab away and back, hides every column and puts them
  back from the empty grid. Then *Clear filters*: off with nothing to clear, back to every row
  after a builder filter and after a raw `WHERE`, and no read at all for a filter only drafted.
  The raw `WHERE` is typed a key at a time, with a `>=` in it, and must look the same as that text
  drawn afresh. Last it narrows the window with an edit staged and checks the toolbar still fits
- **routines** — creates a procedure, opens it from the tree, edits three places in it and checks
  each is marked as what it is (changed, added, removed); opens a change and reads the stored line
  in it, reverts that change alone and takes the revert back with `Ctrl+Z`, steps between changes
  from the toolbar and the keyboard, reverts the rest, then runs the tab and checks the server has
  the edit and the marks start again from it — and that a partial run moves nothing. Then closes
  it with changes unsaved: Cancel keeps it, *Close all* from another tab still asks, Discard leaves
  the server alone, an unchanged routine closes without asking, *Save and close* writes it, and a
  save that fails keeps the tab and shows it
- **unsaved** — disconnects with nothing unsaved and checks nothing is asked; then, with a row staged
  in a table and a routine changed, checks disconnecting asks about both and says it is
  disconnecting, and that Cancel keeps the connection; that switching the table to its structure
  asks too; that the window's ✕ and File → Exit ask in
  their own words and Cancel keeps the window and the app; and that once every question is answered
  the window really does close and the app goes with it
- **auto-refresh** — checks a table opens with it off and offers the fixed intervals in a menu lined
  up under its button, with *Off* ticked and focused; turns it on and waits for a row written from
  outside to turn up unprompted, stages an edit and checks it holds
  (and says why) until the edit is discarded, takes the tab away and back, turns it off, and drops
  the table under it to see a failed read switch it off with a word about it
- **read-only** — saves a writable and a read-only connection to the container and checks the list
  marks only the read-only one and its form keeps the setting; connects it and checks the status bar
  and the query toolbar say so; runs a script that reads and then deletes and checks it is refused
  whole, by line, and that a read on its own still runs; opens a table and checks nothing there can
  be edited, and that *Truncate* and *Drop* are greyed in the tree's menu. Then it goes round the
  window: staged edits, truncate, drop and a raw filter with a `DELETE` in it, sent straight to the
  main process, are each refused, and the rows are counted to show none of it happened. Last it
  switches it where it is used: the status bar's *Read-only* switch asks before turning it off, with
  the focus on *Keep read-only* and Escape keeping it; once told, a delete goes through with no
  reconnect, the switch still there and still labelled, and turned back on — without a question —
  the next one is refused. *File → Toggle Read-only* asks the same; the padlock on a row of the
  list, and the row's ⋮ menu, turn a connection on and, after the question, off without connecting
  it; and in the form, unticking it asks over the form, Escape answers only the question, and
  *Cancel* leaves the saved setting as it was
- **certificate** — a connection that checks certificates, against the test server's self-signed
  one. *Test connection* in the form asks to trust it, with the focus on *Cancel*; *Trust and retry*
  ticks the form's box and the test succeeds, with nothing saved. *Connect* from the list asks too:
  *Cancel* leaves it unconnected and untrusted, and *Trust and retry* saves the setting and connects
- **confirm-writes** — saves a writable connection and one that confirms its writes, and checks the
  list, the status bar and the query and table toolbars mark only that one. A script that reads
  runs without a question; one that writes stops on the question, listing the `DELETE` with its line
  and database, with the focus on *Cancel*: Escape sends nothing and *Run anyway* runs it. An
  `UPDATE` with no `WHERE` keeps *Run anyway* asleep until the table's name is typed, in any case
  but not in part. The same writes sent straight to the main process without the mark — a script,
  staged edits, truncate, drop, a raw filter — are each refused, and the rows are counted. *Apply*
  in a table asks too, listing the `UPDATE` it sends, and so does *Truncate* from the tree. Last the switch: off asks first
  (*Keep confirming* has the focus, Escape keeps it), after which a write runs without a question;
  on does not ask; and read-only turned on and off again lands back on confirming without asking
- **workbench** — `Ctrl+P` opens quick open with the focus in it; typing finds the table, Enter
  opens it, Escape closes the box, and `Shift+Enter` opens a table's structure. Selecting rows puts
  their figures in the footer — a decimal column's sum to its places, a bigint's past 2^53 exact,
  a text column's distinct count — and in a query's results bar. A transaction left open on one
  session blocks a read on another: the activity monitor, opened from the View menu, shows them as
  a chain with the head blocker first and marks its own session; *Kill* asks, ends the head, and
  the read finishes with the value rolled back. A CSV file dropped on a table's rows opens the
  import dialog with its columns matched by name and the bad row named by its line; staging puts
  the rows in the grid and *Apply* sends them as one multi-row `INSERT`. `Ctrl+V` pastes a
  tab-separated range over two rows, then past the last row as new ones. `Ctrl+L` shows an
  estimated plan, `Ctrl+M` an actual one beside the rows, and the run after them is an ordinary one.
  The call a long query's notification goes through returns quietly where there is no notification
  daemon
- **ssm-form** — drives the tunnel picker, validates the instance ID, pastes a credentials block
  with *Paste from clipboard* (after checking that something else on the clipboard never reaches
  the box), fetches the account's instances and picks the bastion from the list (including the
  empty answer a wrong region gives), switches the connection to finding that bastion by its Name
  tag and back, runs the prerequisite check in both its failing and passing states, saves, reopens
  the connection to confirm the stored summary appears while the secret never reaches the renderer,
  pastes a fresh block into the dialog a run-out one raises, and opens a second window.
  `scripts/e2e.sh` writes stand-ins for `aws` and `session-manager-plugin` into `.tmp/bin`, so it
  needs no AWS account.
- **ssm-sso** — the same stand-ins, with an AWS SSO session that has run out until `aws sso login`
  renews it (`FAKE_AWS_SCENARIO=sso-expired`; the stand-in's `sso login` prints what the real one
  does with `--no-browser` and finishes a few seconds later). *Check prerequisites* fails the
  credentials and offers *Sign in with AWS SSO*; the sign-in waits, switches to a code on *sign in
  with a code* (`--use-device-code`, the page and code shown), and the check runs again and passes.
  Then connecting raises the expired-credentials dialog with signing in as its action; *Cancel*
  stops the CLI before it finishes, and a second sign-in retries the connection, which opens
  through the stand-in's session to the test SQL Server — so this one needs the test environment.

Screenshots land in `.tmp/`.

## The README's animations

The GIFs in the README, kept in `docs/images/`, are filmed from the real app rather than mocked up.
`npm run readme:gifs` builds it, opens it on a virtual display of its own against the test
environment's SQL Server, drives it with real mouse and keyboard input, and films each scene with
ffmpeg. Record them again when a change alters what one of them shows.

```bash
apt-get install -y xvfb xdotool ffmpeg gifsicle   # gifsicle is optional: it makes the files smaller
scripts/test-env.sh up
npm run readme:gifs                               # every scene; or name some: npm run readme:gifs -- edit query
```

It needs the same libraries as the end-to-end suites. The scenes:

| Scene | What it shows |
| --- | --- |
| `browse` | The connection list; connecting, opening `orders`, sorting it newest first, the row panel, and following `customer_id` to the customer |
| `edit` | A raw `WHERE`, three statuses changed in the grid, and the change set applied |
| `query` | A query typed with completion from the schema, and its results |
| `read-only` | A read-only production connection refusing a `DELETE` |

They run against `acme_coffee`, a made-up coffee roaster's database that
`scripts/readme-gifs/demo-data.mjs` builds on the test server, with an `app` login for the
production connection. It is dropped and built again before every scene, from a fixed seed, so a
scene recorded on its own looks the same as one recorded with the rest. The scenes themselves are in
`scripts/readme-gifs/record.mjs`. Three things there work around filming on a display with no
window manager: the recorder gives the window the keyboard itself, or nothing typed reaches the page;
applying edits skips the review of its statements, which keeps the scene on the edit itself; and
no scene opens a native `<select>`, whose list does not appear at all.

## Working on the UI

The design tokens and shared controls live in `src/renderer/src/styles/index.css`.
`design-system/tableview/MASTER.md` writes the same system down — palette, type, spacing,
components, motion, and what not to do — and is the first thing to read before changing how
something looks.

## Claude Code setup

`.claude/` holds project skills and one hook. Claude Code picks them up in any session on this
repository, local or in the cloud, with nothing to install.

**UI UX Pro Max** ([nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill),
MIT) lives in `.claude/skills/ui-ux-pro-max/`. Ask for it by name, or let a UI task trigger it. It
searches a local database of styles, palettes, font pairings and UX guidelines with
`python3 .claude/skills/ui-ux-pro-max/scripts/search.py` — Python 3 and the standard library, no
network. Its instructions have Claude read `MASTER.md` before building a screen and leave it
unchanged without your say-so, so new work follows the shipped system rather than a freshly
generated one.

It was installed from `ui-ux-pro-max-cli` 2.15.0. To move to a newer release:

```bash
npx ui-ux-pro-max-cli@latest init --ai claude --force
# The installer also adds six companion skills (banners, brand, logos, slides,
# design tokens, shadcn/Tailwind) that this project has no use for.
rm -rf .claude/skills/{banner-design,brand,design,design-system,slides,ui-styling}
```

**Superpowers** ([obra/superpowers](https://github.com/obra/superpowers), MIT) is Jesse Vincent's
library of working-method skills: brainstorming a design before building it, writing and executing
plans, test-driven development, systematic debugging, verifying before calling something done,
requesting and receiving code review, worktrees, subagent-driven development and finishing a branch.
Its fifteen skills sit beside UI UX Pro Max in `.claude/skills/` (`brainstorming` through
`writing-skills`), copied unmodified from the v7.0.0 release.

What makes it more than a shelf of skills is its session-start hook, and that is wired up too:
`.claude/settings.json` runs Superpowers' own script (`.claude/hooks/`, also unmodified) at the
start of a session, after `/clear` and after compaction. It loads the `using-superpowers` skill into
the conversation, which has Claude check for a skill that applies before it acts — brainstorming
before building, systematic debugging before fixing — the way the plugin does. The command sets
`CLAUDE_PLUGIN_ROOT` only because that is what makes the script answer in Claude Code's format;
Claude Code sets it for plugins but not for project hooks. Instructions in `CLAUDE.md`, or given
directly, still take precedence over the skills.

- **To keep the skills but drop the always-on behaviour**, delete the `SessionStart` entry from
  `.claude/settings.json`. The skills stay available when asked for by name.
- **The skills refer to each other as `superpowers:<name>`**, the plugin's namespace. As project
  skills they are named without it: `brainstorming`, not `superpowers:brainstorming`.
- **Don't also install the Superpowers plugin** (`/plugin install superpowers@claude-plugins-official`)
  for this repository, or every skill and the hook will be loaded twice.

To move to a newer release, copy its skills and hook script over these, and delete any skill the
release dropped:

```bash
TAG=v7.0.0   # the release to move to
git clone --depth 1 --branch "$TAG" https://github.com/obra/superpowers /tmp/superpowers
cp -R /tmp/superpowers/skills/. .claude/skills/
cp /tmp/superpowers/hooks/run-hook.cmd /tmp/superpowers/hooks/session-start .claude/hooks/
```
