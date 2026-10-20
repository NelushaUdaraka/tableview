# Installing and updating

Every release is on the [Releases page](https://github.com/NelushaUdaraka/tableview/releases), and
the [README](../README.md#download) says which file is which.

## Windows

The installer (`…-windows-x64-setup.exe`) lets you choose where TableView goes and adds Start menu
and desktop shortcuts. It is the copy that updates itself. The portable exe
(`…-windows-x64-portable.exe`) runs from wherever you put it, with nothing to install.

Unsigned builds make Windows SmartScreen warn on the first install: choose *More info*, then
*Run anyway*.

## Linux

The AppImage runs on most distributions without installing: mark it executable
(`chmod +x TableView-*.AppImage`) and open it. It mounts itself with the FUSE 3 that desktop
distributions already install; where FUSE is missing altogether — some containers and minimal
installs — run it with `--appimage-extract-and-run`. Keep it somewhere you can write to, such as
`~/Applications`, so that it can update itself.

The .deb, for Debian, Ubuntu and their relatives, installs into `/opt/TableView` with a menu entry:

```bash
sudo apt install ./TableView-<version>-linux-amd64.deb   # or -linux-arm64.deb
```

## Keeping up to date

- **The Windows install and the Linux AppImage update themselves.** Each looks for a new release
  shortly after it starts and every four hours after that, downloads one in the background (the
  AppImage only the parts that changed), and says when it is ready: *Restart* installs it there and
  then, and otherwise it installs the next time TableView quits. Restarting asks about unsaved work
  first, the way quitting does, then says *Installing TableView <version>* over the window for a
  moment before it closes: the Windows installer runs out of sight and TableView is gone until it
  has finished, which can take a minute, so the window going should not be taken for a crash. The
  first window of the new version then says *TableView updated to <version>*, with *What's new*
  for that release's page. That notice compares the version with the one that last ran (kept in
  `last-run.json` in the app's data folder), so it shows after any update, a .deb upgraded by hand
  included, and not on a first run. The AppImage swaps its own file for the new one, so it has to live
  somewhere you can write to — `~/Applications`, say, rather than `/opt`.
- **The portable exe and the .deb say so, and leave the download to you.** A single exe cannot
  replace itself while it runs, and a package is installed the way its system installs packages,
  not from inside the app — so they look just as often and offer the release page instead.
- **Off is off.** *Update automatically* in Settings is on by default. Turned off, nothing is looked
  for, downloaded or installed unasked; *Help → Check for Updates*, or *Check now* beside the
  switch, still asks, and what that finds is fetched and installed like any other update.
- Releases come from this repository's GitHub releases, published by the release workflow — see
  [Releasing](releasing.md).

## Coming from Beekeeper Clone

TableView used to be called Beekeeper Clone. The first time it starts, it copies what the old app
saved (connections, query history, saved queries, settings and window layout) from
`%APPDATA%\beekeeper-clone` into its own `%APPDATA%\TableView` (the same two folder names under
`~/Library/Application Support` on macOS and `~/.config` on Linux), and leaves the old folder as it
was. Saved passwords come across too, except where macOS's keychain or a Linux desktop keyring
holds them under the old name; those have to be entered once more. It only copies into a TableView
that has saved nothing yet, so it never runs twice.

The app ID changed with the name, so Windows installs TableView beside Beekeeper Clone rather than
over it. Once your connections are there, uninstall Beekeeper Clone. Connection exports it wrote
still import.
