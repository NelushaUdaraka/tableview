# Importing connections from TablePlus

**Date:** 2026-10-19
**Status:** design agreed; reviewed; waiting on the user's read-through before a plan is written
**Mockups:** https://claude.ai/artifact/VQX8rEmRdkveRRPAA2rNyC (option A is the one chosen)

## Why

People moving to TableView from TablePlus have their SQL Server connections saved there, and today the
only way across is to retype every host, login, password and option by hand. This makes bringing a
connection over a copy and a paste.

The user works on Windows and has connections in TablePlus and Beekeeper Studio. TablePlus comes
first because it can hand a connection out in a standard form, a URL. Beekeeper has no export at all
(its maintainers' answer is "back up `app.db`"), so it waits.

## Goals

- Bring one TablePlus connection into TableView by copying its URL in TablePlus and pasting it into
  TableView's New connection form, which fills in everything the URL carries.
- Tell people, step by step and inside TableView, how to get that URL out of TablePlus.
- The password comes across with the connection and is stored like one typed into the form
  (encrypted, in the vault).

## Non-goals

- Beekeeper Studio, or any app other than TablePlus.
- Reading TablePlus's own settings files, or its `.tableplusconnection` export file (an
  undocumented, password-protected format).
- Bringing many connections over in one go. One URL is one connection; the person does them one at
  a time.
- Connections to anything but SQL Server.
- Editing an existing connection from a URL.
- Registering TableView as the handler for `sqlserver://` links.

## Anti-goals (would be a failure even if it worked)

- Anything saved without the person pressing **Save**.
- An existing connection changed or replaced by an import.
- Anything on the clipboard other than a TablePlus URL reaching the window. The paste works the way
  the AWS credentials box already does: the main process reads the clipboard and hands over only
  what it was asked for.
- The password shown in plain text anywhere along the way.
- A connection that was protected in TablePlus arriving less protected in TableView (see "Safe
  modes" below).

## Constraints

- Windows first. The user has confirmed that TablePlus for Windows has **Copy as URL**. The URL's
  details below come from TablePlus's own docs, which are written for macOS, so the parser is
  tolerant where they could differ (see "Settled after review").
- SQL Server only (`DbEngine` is `'sqlserver'`).
- The repository's invariants hold: secrets are stored encrypted by the main process; the clipboard
  is read in the main process; UI uses the tokens and shared components in
  `src/renderer/src/styles/index.css` and `design-system/tableview/MASTER.md`; icons come from
  `lib/icons.ts`; class names and button text that `test/e2e/*.mjs` reads stay as they are.

## What the user decided

- **TablePlus only, for now.** Beekeeper is out until it has an export of its own.
- **Use TablePlus's own export, not its files.** The person uses TablePlus's **Copy as URL**; TableView
  takes the URL they paste and shows them how to get it.
- **Option A from the mockups: one at a time, through the New connection form.** Pasting fills in
  the form, the person looks it over, and nothing is saved until they press Save.
- Confirmed when it was played back to them:
  - The password in the URL comes across and is stored encrypted like a typed one.
  - The TablePlus name becomes the name; the TablePlus colour becomes the connection's colour,
    matched to the nearest TableView colour.
  - A URL for PostgreSQL, MySQL or anything else is turned down with a plain sentence saying
    TableView only connects to SQL Server.
  - If a connection with the same name is already saved, the form says so before saving, and saving
    never touches the existing one.
  - **Import from TablePlus…** sits in the connection list's ⋮ menu and in the File menu, and opens a
    new connection with the TablePlus panel open and its steps showing. A new connection opened the
    usual way shows the same panel folded to one line. Editing an existing connection does not show
    it.
  - If the URL's tunnel uses an SSH key file, the Tunnel tab asks for the file, because the URL does
    not carry it.
  - TablePlus's environment tag (production, staging…) becomes the connection's group.
  - After Save the person is back at the list and starts the next one from the menu again.

## How it behaves

### Getting there

- The connection list's ⋮ menu (`transferItems` in `ConnectionScreen.vue`) gains **Import from
  TablePlus…** between *Import connections…* and *Export connections…*.
- The File menu (`src/shared/menu.ts`) gains **Import from TablePlus…** after *Import Connections…*,
  as a new menu action. It is handled wherever *New Connection…* (`connection:new`) is handled
  today — the connection screen — so it behaves the same way *New Connection…* does in a connected
  window.
- Both open the New connection dialog (kicker *New connection*, as now) with the TablePlus panel
  **open**: steps showing.
- *New connection* opened any other way shows the panel **folded** to one line with the same
  *Paste URL* button and a way to unfold the steps.
- The panel is not shown when editing a saved connection or a duplicate.

### The panel

Sits at the top of the form's General tab, as drawn in mockup A. Open, it reads:

> **Bringing this over from TablePlus?**
> 1. In TablePlus, right-click the connection in the start window.
> 2. Choose **Copy as URL**.
> 3. Come back and press Paste URL. Everything below fills itself in.

with a **Paste URL** button (secondary `.btn`, clipboard icon). Folded, it is one line — "Coming from
TablePlus? Paste its URL" — with the same button and a control that unfolds the steps. The wording of
step 1 follows TablePlus's docs; the user has confirmed the Windows build has *Copy as URL*.

Under the panel, one status line (polite live region, like `AwsCredentialsBox`'s) says what the last
paste did:

| What happened | Status line |
| --- | --- |
| Filled in | ✓ Filled in from TablePlus · password included · colour red · SSH tunnel |
| Clipboard empty | The clipboard is empty. In TablePlus, right-click the connection and choose Copy as URL. |
| Not a TablePlus URL | The clipboard doesn't hold a TablePlus URL. In TablePlus, right-click the connection and choose Copy as URL, then paste again. |
| Another database | That's a PostgreSQL connection. TableView only connects to SQL Server. |
| Name already saved | You already have a connection called "Orders (prod)". Saving adds this one beside it; that one stays as it is. |
| Key file needed | Choose the SSH key file on the Tunnel tab — TablePlus doesn't put it in the URL. |
| No login in the URL | No login came with this URL. If the connection signs in with Windows or Microsoft Entra ID, set that up by hand before saving. |
| Arrives read-only | TablePlus had a safe mode on for this one, so it arrives read-only. Untick Read-only before saving if you don't want that. |

The last four can appear alongside the "Filled in" line. Wording is the builder's to polish; the facts
each line states are not.

### The paste

1. *Paste URL* asks the main process for the TablePlus URL on the clipboard (a new IPC channel,
   beside `clipboard:awsCredentials`).
2. The main process reads the clipboard text. If it is a TablePlus URL of any scheme it hands it
   over; otherwise it throws an error with the message above and nothing reaches the window.
   (Recognising other schemes is what lets the window say "That's a PostgreSQL connection" without
   ever seeing the text.)
3. The window parses the URL with a pure shared function and, for a SQL Server URL, **replaces** the
   whole form with what the URL holds, starting from the form's blank state — the same way a pasted
   AWS block replaces the box rather than adding to it. A second paste replaces the first.
4. The password goes into the password field (masked) and counts as typed, so Save stores it.
5. Nothing is saved. The person reviews, can press *Test connection*, and presses *Save*, which goes
   through the existing save path.

### What fills in

TablePlus URLs, from TablePlus's docs ([Connections & Command Line](https://tableplus.com/docs/gui-tools/manage-connections)):

```
sqlserver://user:password@host:port/database?name=…&statusColor=…&env=…&safeModeLevel=…
sqlserver+ssh://ssh_user:ssh_password@ssh_host:ssh_port/user:password@host:port/database?…
```

The scheme is `sqlserver` or `microsoftsqlserver`; every value is percent-encoded; the copied URL
"includes the passwords and the connection's options".

| TablePlus | TableView field | Rule |
| --- | --- | --- |
| scheme `sqlserver` / `microsoftsqlserver` (with or without `+ssh`) | `engine: 'sqlserver'` | Any other scheme is refused, naming the database (`postgresql`/`postgres` → PostgreSQL, `mysql` → MySQL, `mariadb` → MariaDB, and so on; an unknown one by its scheme). |
| database user / password | `username`, `password`, `authType: 'sql'`, `savePassword: true` | Percent-decoded. No password → empty field, nothing to store. |
| database host / port | `host`, `port` | Port absent → 1433. |
| path | `database` | First path segment, decoded. Absent → empty (the form's default). |
| `name` | `name` | Decoded. Absent → the host. |
| `statusColor` (hex, no `#`) | `color` | The nearest non-default swatch in `ACCENT_SWATCHES` (`shared/accent.ts`). Absent or unreadable → no colour. See "Settled after review" for a colour TablePlus may write when nobody chose one. |
| `env` | `group` | First letter capitalised (`production` → `Production`); custom tags kept as written otherwise. Absent → no group. *My call:* whatever TablePlus writes for a connection nobody tagged counts as no group, so an untouched connection does not start a "Local" group and turn group headings on for the whole list. |
| `safeModeLevel`, `advancedSafeModeLevel` | `readOnly` | `safeModeLevel` above 0 → `readOnly: true`, and the "Arrives read-only" line shows. Absent or 0 (Silent) → writable. `advancedSafeModeLevel` only picks between a mode's two variants and does not change the outcome. See "Safe modes" below. |
| `+ssh` | `ssh.enabled: true`, `ssh.host`, `ssh.port` (absent → 22), `ssh.username` | From the first authority. |
| ssh password | `ssh.authMode: 'password'`, `ssh.password` | When `usePrivateKey` is not `true` and a password is present. |
| `usePrivateKey=true` | `ssh.authMode: 'privateKey'`, `ssh.privateKeyPath: ''` | The key's path is not in the URL; the "Key file needed" line shows and the Tunnel tab marks the key field. |
| `usePrivateKey=true` and an SSH password | `ssh.passphrase` | *My call:* with a key, the password slot is the key's passphrase. |
| neither a key nor a password | `ssh.authMode: 'agent'` | *My call:* TablePlus falls back to the SSH config/agent in that case. |
| no database user in the URL (as a Windows or Microsoft Entra ID sign-in would leave it) | `authType: 'sql'`, user and password left empty | *My call:* fill in everything else and say on the status line that no login came with the URL, rather than turning it down — the person is looking at the form anyway. Detected by the missing user, so it does not depend on how TablePlus writes the sign-in type. |
| `tLSMode` | — | *My call:* ignored; the form's defaults (`encrypt` and `trustServerCertificate` on) stand, since TablePlus doesn't publish what its numbers mean. |
| `windowMode`, `driverVersion`, `lazyload`, `schema`, `table`/`view`, filter parameters | — | Ignored. |

Everything else is the form's blank default (`DEFAULT_SQLSERVER_OPTIONS`, `DEFAULT_SSH_CONFIG`,
`DEFAULT_SSM_CONFIG`).

### Same name

Compared case-insensitively against the saved list, the way `planImport` compares names. The line
says so; Save is not blocked, and saving creates a new connection beside the existing one.

## Settled after review

### Safe modes (my call — the user was offered it and has not overruled it)

TablePlus has no read-only mode. Its lock icon sets one of Silent, Alert 1 and 2 (warn before
sending queries) or Safe 1 and 2 (ask for a password before sending queries; the "2" variants let
SELECT/EXPLAIN through), carried in the URL as `safeModeLevel` (0–2) and `advancedSafeModeLevel`
(0–1). TableView has only read-only on or off, and read-only is stricter than any of them: it refuses
every write and every `EXEC`.

Rule: **any safe mode other than Silent arrives read-only.** That keeps the anti-goal — nothing
protected in TablePlus arrives less protected — and costs one click to undo: the person can untick
Read-only in the form before saving (a box ticked in this sitting unticks without a question), or
later from the padlock on the connection list.

### What the Windows URL looks like (confirmed in part)

The user has confirmed that TablePlus for Windows has **Copy as URL** on a saved connection's
right-click menu. No sample URL has been seen yet, so the parser follows TablePlus's docs and is
tolerant where Windows could differ:

- Query values are decoded the way browsers decode a query string (`URLSearchParams`), so a space
  arrives whether it is written `%20` or `+`. The user and password are percent-decoded only, so a
  `+` in a password stays a `+`.
- Parameter names are matched as documented (`name`, `statusColor`, `env`, `safeModeLevel`,
  `advancedSafeModeLevel`, `usePrivateKey`, `tLSMode`); unknown ones are ignored, not refused.
- A `statusColor` with or without a leading `#`, in either case, is read.
- "No group" and "no colour" for an untouched connection: an absent or empty `env` is no group. A
  colour is mapped whenever one is present; if a real URL later shows that TablePlus writes a stock
  colour for every connection, that stock colour is added as "no colour" — a one-line change with a
  test.

If the user pastes a real URL later (password and host swapped out), it becomes a unit-test
fixture and settles the last point.

## Where it fits in the code (suggested; the builder may arrange it differently)

- `src/shared/tableplus.ts` — pure: recognise a TablePlus URL, parse it, and turn a SQL Server one
  into the form's fields plus notes for the status line (password included, colour, SSH, key file
  needed). Also the clipboard check the main process runs, shaped like
  `credentialsFromClipboard` in `shared/aws/credentials.ts`.
- `src/shared/ipc.ts`, `src/main/ipc/index.ts`, `src/preload/index.ts`, `renderer/src/lib/api.ts` — the
  new clipboard channel.
- `src/renderer/src/components/TablePlusPanel.vue` — the panel and its status line, used by
  `ConnectionForm.vue` for new connections only.
- `ConnectionForm.vue` — applies a parsed URL to `form` from the blank state and marks the password
  as touched; a prop saying whether the panel starts open.
- `ConnectionScreen.vue` and `src/shared/menu.ts` — the two menu entries.

## Testing

- **Unit (`test/unit/tableplus.test.ts`):** plain URL; `microsoftsqlserver` scheme; `+ssh` with a
  password; `+ssh` with `usePrivateKey=true`; `+ssh` with neither; missing port, name, database and
  password; percent-encoded name, user and password (with `@`, `:`, `/`, `?`, `#`, `%`, `+` in them);
  `statusColor` mapped to the nearest swatch, absent and malformed; `env` to group; each refused
  scheme named; text that isn't a URL; the clipboard check refusing non-TablePlus text with the
  right message. Safe mode: absent and 0 arrive writable; 1 and 2, with either
  `advancedSafeModeLevel`, arrive read-only. A space written as `%20` and as `+` in `name`; a `+` in
  the password kept.
- **E2E (`test/e2e/connections.mjs`, which needs no database):** put text on the clipboard with
  `window.api.copyToClipboard` (as `ssm-form.mjs` does); open ⋮ → *Import from TablePlus…*; paste
  something that isn't a URL and check the form is untouched; paste a PostgreSQL URL and check the
  refusal; paste a SQL Server URL and check the fields, the masked password and the status line;
  save; check the row's name, colour and group; reopen it and check the saved password is reported
  as saved without reaching the window; paste a URL whose name is already saved and check the line
  and that the original is unchanged after saving.

## Left to the builder

- Component and function names, file layout, and how the panel folds and unfolds.
- Final wording of the status lines and the folded line, within the facts stated above.
- How "nearest swatch" is measured.
- How the Tunnel tab marks the missing key file.
