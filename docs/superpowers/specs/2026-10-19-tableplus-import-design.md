# Importing connections from TablePlus

**Date:** 2026-10-19
**Status:** design agreed, waiting on the open questions below
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
- A connection that was protected in TablePlus arriving less protected in TableView (see open
  question 1).

## Constraints

- Windows first. TablePlus's docs are written for macOS; the Windows build's wording has to be
  confirmed (open question 2).
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
step 1 follows whatever open question 2 turns up.

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

The last two can appear alongside the "Filled in" line. Wording is the builder's to polish; the facts
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
| `statusColor` (hex, no `#`) | `color` | The nearest non-default swatch in `ACCENT_SWATCHES` (`shared/accent.ts`). Absent or unreadable → no colour. |
| `env` | `group` | First letter capitalised (`production` → `Production`); custom tags kept as written otherwise. Absent → no group. |
| `safeModeLevel`, `advancedSafeModeLevel` | `readOnly` | **Open question 1.** |
| `+ssh` | `ssh.enabled: true`, `ssh.host`, `ssh.port` (absent → 22), `ssh.username` | From the first authority. |
| ssh password | `ssh.authMode: 'password'`, `ssh.password` | When `usePrivateKey` is not `true` and a password is present. |
| `usePrivateKey=true` | `ssh.authMode: 'privateKey'`, `ssh.privateKeyPath: ''` | The key's path is not in the URL; the "Key file needed" line shows and the Tunnel tab marks the key field. |
| neither a key nor a password | `ssh.authMode: 'agent'` | *My call:* TablePlus falls back to the SSH config/agent in that case. |
| `tLSMode` | — | *My call:* ignored; the form's defaults (`encrypt` and `trustServerCertificate` on) stand, since TablePlus doesn't publish what its numbers mean. Revisit if open question 2 shows otherwise. |
| `windowMode`, `driverVersion`, `lazyload`, `schema`, `table`/`view`, filter parameters | — | Ignored. |

Everything else is the form's blank default (`DEFAULT_SQLSERVER_OPTIONS`, `DEFAULT_SSH_CONFIG`,
`DEFAULT_SSM_CONFIG`).

### Same name

Compared case-insensitively against the saved list, the way `planImport` compares names. The line
says so; Save is not blocked, and saving creates a new connection beside the existing one.

## Open questions (for the user)

1. **TablePlus has no read-only mode.** Its safe modes are Silent, Alert 1 and 2 (warn before
   sending queries) and Safe 1 and 2 (ask for a password before sending queries; mode 2 lets
   SELECT/EXPLAIN through). The URL carries them as `safeModeLevel` (0–2) and
   `advancedSafeModeLevel` (0–1). The agreed rule — "read-only in TablePlus arrives read-only here" —
   has nothing to map from as stated. Something has to decide which, if any, of those levels makes a
   connection arrive read-only in TableView.
2. **What a Windows TablePlus URL really looks like.** The docs are written for macOS, and nothing
   online confirms that the Windows build has *Copy as URL* or names it the same. One real URL from
   the user's TablePlus on Windows (password and host swapped out) — ideally one plain and one over
   SSH — would settle the menu wording in the steps, which parameters appear, how safe mode and the
   colour are written, and whether a connection with no colour of its own still carries a
   `statusColor`.

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
  right message. Safe-mode mapping once open question 1 is settled.
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
