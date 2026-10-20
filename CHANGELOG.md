# Changelog

What changed in each release of TableView, newest first. The downloads are on the
[Releases page](https://github.com/NelushaUdaraka/tableview/releases); a version at the top that is
not there yet is the next release, still being prepared.

## 0.2.0

- TableView remembers how you left it: after a restart the sidebar comes back at the same width,
  shown or hidden as you left it and on the same Schema, History or Saved panel, the query editor
  keeps its height, and a table you left refreshing automatically refreshes again at the same
  interval when you next open it (choose *Off* to stop that).
- A narrow sidebar no longer pushes the Schema, History and Saved switch past its edge: the labels
  shorten to fit instead.
- In a narrow window the connection list no longer hides the names of read-only connections: their
  *Read-only* badge shrinks to its lock icon so the name keeps its room.

## 0.1.3

- Restarting to install an update no longer just makes TableView vanish: the window says it is
  installing the new version, and on Windows the installer then opens in view with its progress
  (click *Next* and *Finish*, and TableView starts again) instead of working silently. Once it is
  back, a notice says which version it was updated to, with a link to what is new in it.

## 0.1.2

- The sidebar opens wider, at 320px rather than 280px, so table names are cut short less often.
- Toasts put themselves away: a notice after four seconds, as before, and now an error too, after
  eight. Resting the pointer on a toast holds them all until it leaves. The update notices with
  *Restart* or *Download* on them still wait for an answer.

## 0.1.1

- Every download is named for the system and the processor it runs on —
  `TableView-0.1.1-windows-x64-setup.exe`, `TableView-0.1.1-linux-x86_64.AppImage`,
  `TableView-0.1.1-linux-amd64.deb` and so on — so a release page says which file is for which
  computer. Installed copies keep updating as before.

## 0.1.0

- The first release: an installer and a portable exe for Windows, and AppImages and .debs for Linux
  on x64 and arm64. The installer and the AppImages update themselves from these releases.
