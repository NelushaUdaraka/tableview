# Known limitations

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
- **A named bastion needs `ec2:DescribeInstances`.** Names are matched by EC2, so an identity that
  can start a session but cannot describe instances has to point the connection at an ID instead.
- **Read-only mode reads the script, not the server.** SQL Server has no session switch that refuses
  writes, so the check is the app's own reading of the T-SQL, and it errs towards refusing: `EXEC`
  is turned down even for `sp_help`, and a `#temp` table counts as a write like any other. A login
  that can only read is the guarantee; the setting is the safety net.
- **Confirm writes lists statements as a lexer sees them.** It lists each statement that writes and
  spots an `UPDATE` or `DELETE` with no `WHERE` from the words of the script, not a parse of it: a
  `WHERE` hidden in dynamic SQL is not seen, and a procedure is listed as running a procedure,
  whatever it does inside. Whether to ask at all is the read-only check, which errs towards asking.
- **macOS builds do not update themselves.** The release workflow builds for Windows and Linux, so a
  macOS package has no release to update from and does not look for one. Nor does a Linux package
  other than the AppImage and the .deb.
- **The AppImage can run without Chromium's sandbox.** Ubuntu 24.04 and later restrict the user
  namespaces the sandbox is built on, and an AppImage cannot carry the AppArmor profile that would
  lift that; where the sandbox cannot start, its launcher adds `--no-sandbox` rather than fail to
  open. The .deb installs that profile, and keeps the sandbox.
- **The AppImage's runtime is still a beta in electron-builder.** It is the one that opens without
  libfuse2 (see [Build for Linux](development.md#build-for-linux)), and it has built, run and updated itself here,
  restart included; if it ever misbehaves, deleting `toolsets` from `electron-builder.yml` goes back
  to the default, at the price of libfuse2.
- **The renderer bundle is ~1.7 MB** (CodeMirror and the SQL formatter dominate). Fine for a desktop
  app; worth code-splitting if startup time ever matters.
- **Query results are capped** at `maxResultRows` (50 000 by default). Rows past the cap are counted
  but not retained, and the results header says so.
