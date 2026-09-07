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
- Passwords and SSH secrets encrypted at rest — the OS keystore via Electron `safeStorage` where
  available, AES-256-GCM under a `0600` key file otherwise. Secrets never reach the renderer.
- Test-connection button that reports the server edition and version

**Connecting through an AWS bastion (SSM)**

Pick *AWS SSM* on the connection's Tunnel tab instead of running the CLI by hand. The session starts
when you connect and is torn down when you disconnect — including the `session-manager-plugin`
grandchild, which on Windows has to be killed as a process tree or it keeps holding the local port.

- **Forward to a remote host** — the bastion relays to an RDS endpoint or another internal listener.
  Uses `AWS-StartPortForwardingSessionToRemoteHost`; the Server field is resolved *from the bastion*.
- **Forward to the instance itself** — SQL Server runs on the bastion. Uses
  `AWS-StartPortForwardingSession`.

Set the instance ID, and optionally a region, a fixed local port (blank picks a free one) and an
explicit CLI path. **Check prerequisites** verifies the three things that actually go wrong — the
AWS CLI, the Session Manager plugin, and whether your credentials are still valid — and
`aws sts get-caller-identity` confirms which identity you are about to connect as.

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

Requires AWS CLI v2 and the Session Manager plugin on the machine running the app, and
`ssm:StartSession` permission on the instance and the port-forwarding document.

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

**Table editing**
- Edit cells in place, insert rows, mark rows for deletion — all staged locally
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
- SQL formatting, open/save `.sql` files, saved queries, searchable query history

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
| `npm test` | 343 unit tests — SQL building, T-SQL lexing, value serialisation, exporters, credential vault, storage, driver config |
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
scripts/e2e.sh all          # or: smoke | workspace | editing
```

On a headless box it starts Xvfb itself. It needs Electron's usual Linux libraries:

```bash
apt-get install -y xvfb libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2t64 libnss3 libnspr4 libgtk-3-0t64 libatspi2.0-0t64
```

The three suites:
- **smoke** — the window opens, the preload bridge exposes the API, settings load, IPC errors arrive
  as real `Error`s, and a saved password never appears in renderer-visible data
- **workspace** — connects to the container, loads the schema tree, opens a table, reads the grid,
  checks the structure tab, types and runs a JOIN in the editor, provokes a SQL error, toggles theme
- **editing** — edits a cell, stages an insert, applies the change set, verifies the rows in the
  database, deletes through the context menu, and drives the filter builder
- **ssm-form** — drives the tunnel picker, validates the instance ID, pastes a credentials block,
  runs the prerequisite check in both its failing and passing states, saves, reopens the connection
  to confirm the stored summary appears while the secret never reaches the renderer, and opens a
  second window. Uses stand-ins for `aws` and `session-manager-plugin`, so it needs no AWS account.

Screenshots land in `.tmp/`.

---

## Architecture

```
src/
├── main/                     Electron main process
│   ├── db/
│   │   ├── registry.ts       live client per connection
│   │   └── sqlserver/        client, config mapping, catalog queries, type mapping
│   ├── tunnel/               ssh.ts, ssm.ts (AWS Session Manager), shared contract
│   ├── storage/              JSON stores + credential vault
│   ├── ipc/                  handlers, each wrapped in a result envelope
│   ├── menu.ts, window.ts    menu bar, window state
│   └── index.ts
├── preload/index.ts          contextBridge façade
├── shared/                   used by both sides
│   ├── types.ts              the IPC contract
│   ├── aws/credentials.ts    parses the AWS portal's credential blocks
│   ├── sql/                  identifier escaping, T-SQL lexer, query builders
│   ├── serialize.ts          driver values ⇄ IPC-safe cell values
│   ├── export.ts             CSV/JSON/SQL/Markdown
│   └── ipcSerialize.ts       strips Vue proxies before they hit contextBridge
└── renderer/src/             Vue 3 + Pinia
    ├── lib/api.ts            the only place that touches window.api
    ├── stores/               connections, schema, tabs, library, settings, toasts
    ├── components/           grid, editor, sidebar, dialogs
    └── views/                connection screen, workspace, query, table
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

**The renderer converts reactive state to plain data before the bridge.** `contextBridge` clones
arguments with the structured clone algorithm, which refuses to clone a Proxy — which is exactly
what Vue reactive state is. `lib/api.ts` handles this once for every call site.

---

## Known limitations

Deliberately out of scope for phase 1, in rough priority order for phase 2:

- **One engine.** Only SQL Server. The `DbClient` seam is in place but there is no second driver.
- **One connection per window.** Several windows work, but a single window cannot hold two
  connections side by side — the schema store is keyed for one connection at a time.
- **No schema editing UI.** You can drop and truncate from the sidebar and run any DDL you like in
  the editor, but there is no visual "add column" / "create index" builder.
- **No backup/restore, import, or diff tooling.**
- **Confirmations use native `window.confirm`.** Functional, but it blocks the renderer and does not
  match the app's styling; an in-app modal would be better.
- **Named instances cannot be used through an SSH tunnel** — SQL Browser resolves them over UDP 1434,
  which a TCP forward cannot carry. Give an explicit port instead. The app ignores `instanceName`
  when tunnelling rather than failing confusingly.
- **Azure AD support is password-flow only** — no interactive, device-code or managed-identity flows.
- **SSM sessions are not resumed.** If the AWS session drops mid-query the connection fails and you
  reconnect; there is no automatic re-establishment.
- **No interactive AWS prompts.** The CLI child is spawned without stdin, so a profile configured
  with `mfa_serial` cannot be answered, and `aws sso login` (a browser flow) has to be run yourself —
  the app detects the expiry and says so. Pasting portal credentials sidesteps both.
- **Expiry is only known when the block says so.** The portal's environment-variable format carries
  no expiry, so the app can tell you the credentials *are* temporary but not when they lapse; it
  reports the failure when they do.
- **SSM targets are given by instance ID**, not by Name tag — resolving tags would need
  `ec2:DescribeInstances` and a region-wide lookup.
- **The renderer bundle is ~1.7 MB** (CodeMirror and the SQL formatter dominate). Fine for a desktop
  app; worth code-splitting if startup time ever matters.
- **Query results are capped** at `maxResultRows` (50 000 by default). Rows past the cap are counted
  but not retained, and the results header says so.

## Licence

MIT
