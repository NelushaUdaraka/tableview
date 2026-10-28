# Connections

Saving, organising and opening connections: how they sign in, how they reach the server, and what
they do once open. Connecting through an AWS bastion has [a page of its own](aws-ssm.md), as does
[read-only and confirm-writes mode](read-only.md).

## Saving and organising

- Saved connections with name, host/port and default database — each with a colour that becomes the
  whole window's accent, so production never looks like staging
- **Ordered the way you look for them** — the list opens on the connection made most recently and
  re-sorts by name, last opened or endpoint, either way round. The choice is a setting rather than a
  session's whim, so the list is in the same order tomorrow morning. A connection nobody has opened
  yet has no last-opened time at all, so it sorts *after* the ones that have rather than leaping to
  the top when the order is reversed.
- **One button per row, and a ⋮ for the rest** — *Connect* is what a row is for, so it is the only
  button on it; edit, duplicate and delete sit behind the row's ⋮, which raises the same menu a
  right-click always has
- **Filed under groups** — a connection carries the name of a group ("Production", "Client work"),
  and the list draws a heading for each one with the loose connections gathered under *Ungrouped* at
  the end. Typing a name no connection carries yet is what creates a group; the row's ⋮ files others
  under it, and taking the last connection out takes the group with it — there is no empty folder to
  tidy up. Headings fold away, and a search reaches into the folded ones, because the connection
  being typed for is exactly the one a closed heading would be hiding.
- **Duplicate, then edit** — most connections are a variant of one that already works, so
  *Duplicate* copies a saved connection whole (password, SSH passphrase and AWS credentials
  included) and opens the copy in the form with its name selected, ready to be typed over. The
  copy is named apart from its source — `Prod (copy)`, then `Prod (copy 2)`, never
  `Prod (copy) (copy)` — and the original is not touched. From inside the form, *Save as copy*
  does the same the other way round: change a field, fork it, and the connection you opened stays
  as it was. A copy is saved the moment it is made, so *Cancel* stops editing it rather than
  un-making it.
- **Import and export, without the secrets** — *Export connections* writes the list to a JSON file
  and *Import connections* reads one back, which is how a setup moves to a second machine. **No
  password, SSH passphrase or AWS credential block is ever written to that file**: an export lands
  in a downloads folder, goes out as an attachment and ends up in a backup, and none of those are
  places for the key to production. What travels is the shape of each connection — including its
  group, its colour, whether it is read-only or confirms its writes and the day it was made — plus a note of which secrets
  it had, so the toast can say how many will need a password entering rather than leaving it to be
  discovered at connect time. A name already saved is left alone rather than imported beside
  itself, so re-importing the same file to pick up one new connection does not leave you with two
  of everything. Nor does an AWS CLI path travel, in either direction: it names a program this
  machine runs on *Connect*, and a file someone sent has no business choosing that — one pointing at
  a share on their server would have this machine run whatever they put there.
- **…or brought over from TablePlus** — *Import from TablePlus…*, on the list's ⋮ and in the File
  menu, opens a new connection with the three steps for getting one out of TablePlus: right-click
  it in TablePlus's start window, choose *Copy as URL*, and press *Paste URL* here. The form fills
  itself in — server, login and password, database, the colour (matched to the nearest of
  TableView's own), the TablePlus tag as its group, and the SSH tunnel when there is one — and
  nothing is saved until *Save*, so it can be looked over and tested first. A name already in the
  list is called out before saving, and saving puts the new one beside it without touching the
  old; a connection TablePlus kept in any safe mode but *Silent* arrives with *Confirm writes* on,
  since those modes warn or ask before a query is sent, which is what confirm writes does; and
  what the URL cannot carry — an SSH key file, a Windows sign-in — the form asks for. The
  clipboard is read in the main process, and only a SQL Server URL from TablePlus is handed to the
  window: anything else that was copied, another database's URL with its password in it
  included, stays where it is. A new connection opened the usual way offers the same paste,
  folded to one line.

## Signing in and reaching the server

- SQL Server logins, Windows/NTLM (with domain), and Azure AD password auth
- TLS options: `encrypt`, `trustServerCertificate`, named instances, `ApplicationIntent=ReadOnly`,
  connect/request timeouts, pool sizing, application name
- **The server's certificate is checked.** A new connection encrypts and does not take the
  server's certificate on trust, since an encrypted connection to whoever answered keeps out only
  those who are not trying. Most servers on a private network have a certificate of their own
  making, which this computer has no way to check. Connecting to one, or testing it, asks whether
  to trust its certificate, saying what that gives up, with *Cancel* focused: *Trust and retry*
  turns on *Trust server certificate* (under *Advanced*) and tries again. From the list it is saved
  with the connection; from the form it ticks the box, kept when the form is saved. The certificate
  is the same next time, so a dropped connection is not retried over it. Through a tunnel the certificate is checked
  against the server's real name, not the `127.0.0.1` the driver dials. Connections saved before
  this keep the setting they had.
- **SSH tunnelling** with password, private key (with passphrase) or agent auth, `~` expansion,
  keepalives, and an ephemeral loopback-only local port
- **The SSH server is checked, as `ssh` checks it.** The first connection to a server shows its
  key's fingerprint (`SHA256:…`, the form `ssh-keygen -l` prints) and asks whether to trust it;
  *Trust and connect* keeps it, and from then on that address has to present the same key. One
  that presents another gets a warning naming both, with *Cancel* as the default — a rebuilt server
  shows a new key, and so does someone standing in for it to read the password. The key is checked
  before anything is sent to sign in. The list is TableView's own (`known-hosts.json` in its data
  folder), not `~/.ssh/known_hosts`.
- **AWS SSM Session Manager** port forwarding — the app runs `aws ssm start-session` for you and
  points the connection at the port it opens, so there is no second terminal to babysit — see
  [Connecting through an AWS bastion](aws-ssm.md)
- **Bastion picked from the account, not remembered** — paste credentials, choose a region, and the
  connection form lists the instances in it with their Name tags and whether Systems Manager can
  actually reach them
- **…or named rather than picked** — a connection can hold the bastion's *Name tag* instead of its
  ID and resolve it on every connect, so a redeployed bastion needs no edit at all
- Passwords and SSH secrets encrypted at rest — the OS keystore via Electron `safeStorage` where
  available, AES-256-GCM under a `0600` key file otherwise. Secrets never reach the renderer.
- Test-connection button that reports the server edition and version

## Once connected

- **Read-only, for the one that is production** — a connection marked read-only refuses anything
  that would change the database: the grid offers no edits, *Truncate* and *Drop* are greyed, and a
  script with a statement that writes is turned down whole, before any of it is sent. The check is
  made in the main process, so no window can get round it, and the list, the status bar and the
  toolbars all say which connection it applies to. It is switched from the *Read-only* switch in
  the status bar while connected, or from the padlock beside each connection in the list, without
  opening the connection's settings; it changes at once, with no reconnect, and turning it off
  asks first (see [Read-only connections](read-only.md))
- **Confirm writes, for the one you sometimes have to change** — writes go through, but each script
  that writes, each *Apply* and each truncate or drop is shown first, statement by statement with
  the database it changes, and waits for *Run anyway*; a `DROP`, a `TRUNCATE`, or an `UPDATE` or
  `DELETE` with no `WHERE` also wants its table's name typed. Like read-only it is enforced in the
  main process, marked in the list, the status bar and the toolbars, and switched from its own
  switch beside *Read-only* (see [Confirm writes](read-only.md#confirm-writes))
- **Kept alive, and put back when it drops** — an idle connection is poked once a minute (the
  *Keepalive* option; 0 turns it off) so an SSM session, an SSH forward or a firewall does not tear
  it down for want of traffic. A connection that goes anyway is reopened in the background with a
  backoff, for about eight minutes; the status bar says what is happening and offers *Reconnect*
  once it stops trying. Credentials that have run out and a login the server refuses are not retried
  at all — neither is going to fix itself. The window keeps its tabs and staged edits throughout.

## A connection's colour is the window's accent

One colour runs through this UI — the button that acts, the tab that is showing, the selection, the
focus ring — so giving a connection a colour colours the window it is open in, and two windows side
by side stop looking alike. It is not the theme: dark and light are still yours to choose, and the
connection tints whichever one you are in.

The connection stores one hex value. Everything else is derived from it: the hover shade, the tint
the SQL keywords take (lighter on the dark theme, darker on the light one), and whether text on top
of the accent should be white or ink — which is what keeps a pale colour readable rather than
leaving a button nobody can read. The swatches offered are chosen to carry at least 3:1 against both
grounds, since the accent is used as text as well as as a fill. A connection with no colour is the
app's own indigo, exactly as the stylesheet defines it. Red is a swatch rather than the default: it
is the colour people reach for to mark production, which is exactly why every window should not
already be wearing it.
