# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

TableView is an Electron + Vue 3 + TypeScript desktop SQL client. Phase 1 supports only Microsoft
SQL Server, but everything behind the `DbClient` interface (`src/main/db/types.ts`) is engine-agnostic.
`README.md` is the detailed feature spec and documents the reasoning behind most behaviour; read the
relevant section before changing a feature.

## Commands

```bash
npm install            # postinstall runs `install-electron`; run `npx install-electron` by hand if dev says "Electron uninstall"
npm run dev            # hot-reloading dev build (electron-vite)
npm run build          # electron-vite build into out/
npm run build:win | build:linux | build:unpack   # packaged builds via electron-builder, into release/ (never published)

npm run typecheck      # tsc for main/preload/shared (tsconfig.node.json) + vue-tsc for renderer (tsconfig.web.json)
npm test               # unit tests only (vitest project "unit", test/unit/**)
npx vitest run --project unit test/unit/builder.test.ts   # one file
npx vitest run --project unit -t "name of test"           # one test by name
```

There is no lint script; `npm run typecheck` plus the unit tests are the fast checks.

**Releases** are made by `.github/workflows/release.yml` from a version tag (`npm version x.y.z`, then
`git push --follow-tags`; the tag must match `package.json`). It drafts a GitHub release, builds the
Windows installer and portable exe and the Linux AppImages and .debs (x64 and arm64) into it, and
publishes it once every file is up. Installed copies update from those releases, so the repository
must stay public. Building the Windows targets on Linux needs wine (32- and 64-bit).

**Integration tests** (`test/integration/`) run against a real SQL Server 2022 and sshd in Docker:

```bash
scripts/test-env.sh up         # SQL Server on :11433 (sa / Beekeeper#2024!), sshd on :2222; also generates SSH keys into .tmp/
npm run test:integration       # serial, long timeouts; MSSQL_TEST_HOST/PORT/USER/PASSWORD/DATABASE override defaults
scripts/test-env.sh down
```

**E2E tests** (`test/e2e/*.mjs`) build the app, launch real Electron, and drive it over the DevTools
protocol (port 9222). `scripts/e2e.sh <suite>` (or `npm run test:e2e:<suite>`; `all` runs every one)
starts Xvfb on `:99` when there is no `DISPLAY`, kills stray `electron` processes (single-instance
lock), and uses a fresh profile in `.tmp/profile-<suite>`. Most suites need the test environment up;
`connections` and `ssm-form` do not (`ssm-form` uses a fake `aws` CLI from `test/fixtures/fake-aws.mjs`
installed into `.tmp/bin`). Screenshots go to `.tmp/`.

## Architecture

Three Electron layers plus a shared module, with path aliases `@shared` → `src/shared`,
`@main` → `src/main`, `@` → `src/renderer/src` (renderer only).

- **`src/main/`** — main process. `db/registry.ts` holds the live `DbClient` per connection (with
  `reconnect.ts` for keepalive/backoff reconnects); `db/sqlserver/` is the only engine implementation.
  `tunnel/` provides SSH (`ssh2`) and AWS SSM port forwarding (spawns `aws ssm start-session`; on
  Windows the plugin grandchild must be killed as a process tree). `storage/` holds JSON stores and the
  credential vault (Electron `safeStorage`, falling back to AES-256-GCM with a 0600 key file).
  `closeGuard.ts` blocks window close/quit while there is unsaved work. `updater.ts` decides when to
  look for a release and what to do with one (electron-updater is handed in, never imported there):
  the Windows install and the AppImage update themselves (mode `self`), the portable exe and the .deb
  only announce a new release (`notify`), anything else is `unsupported`. Restarting into an update
  (`restartToUpdate` in `index.ts`) asks the close guard first, like a quit.
- **`src/preload/index.ts`** — `contextBridge` façade. Unwraps each `IpcResult` envelope and rethrows
  failures as real `Error`s carrying SQL Server error number/line/procedure.
- **`src/shared/`** — code used on both sides. `ipc.ts` defines `CHANNELS` and the `RendererApi`
  contract; `types.ts` holds the data types. Adding an IPC call touches `shared/ipc.ts`,
  `main/ipc/index.ts` (register via the `handle(...)` wrapper that produces the envelope),
  `preload/index.ts`, and `renderer/src/lib/api.ts`.
- **`src/renderer/src/`** — Vue 3 + Pinia. `lib/api.ts` is the only module that touches `window.api`,
  and it strips Vue reactive proxies (via `shared/ipcSerialize.ts`) because structured clone rejects
  Proxies. Pure logic lives in `lib/` and `stores/` and is unit-tested from `test/unit/renderer/`.

Invariants that span multiple files:

- **`src/main/db/**` never imports Electron**, so integration tests can drive `SqlServerClient` directly.
- **Values are bound as parameters; only identifiers are interpolated**, and only through
  `src/shared/sql/identifiers.ts`. The raw `WHERE` filter box is the single deliberate exception.
- **Scripts split into batches on `GO`, not `;`** (`splitBatches` in `shared/sql/statements.ts`). `splitStatements`
  exists only for editor conveniences like run-statement-under-cursor.
- **Cell values cross IPC tagged** as `{ t: 'date' | 'bytes' | 'bigint' | 'json', v }`
  (`shared/serialize.ts`); bigints stay textual to preserve precision.
- **Secrets never reach the renderer.** Passwords, SSH passphrases and AWS credential blocks stay in the
  main process; connection export (`shared/connectionTransfer.ts`) omits them. The smoke and ssm-form
  e2e suites assert this.
- **Read-only enforcement happens in the main process** (`shared/sql/readOnly.ts` is a T-SQL lexer-based
  check that errs toward refusing, e.g. any `EXEC`). The renderer only greys out UI.
- **The menu is defined once** in `shared/menu.ts`; main builds the native Electron `Menu` from it and
  the frameless title bar renders the same model. Role items (clipboard, zoom, devtools, close) round-trip
  over IPC.
- **App data is written new-file-then-rename with retries** (`storage/store.ts`) for Windows `EPERM`
  locks; window geometry writes are coalesced.
- **Tabs and panes:** `stores/tabs.ts` has one flat tab list and one or two panes; only a pane's active
  tab is mounted. Views holding staged edits register a leave guard against their own tab id, and every
  action that would unmount a view (switch, close, move pane, unsplit, detach to window) asks those
  guards. The split pane is always rendered (collapsed, not replaced) so the first pane never remounts.
- **Table tabs cache their last page** (`markRaw`) and seed the view from it, then re-read in the
  background; `lib/tableCache.ts` decides whether the result actually differs before touching the grid.
  Loads carry a token so only the latest request's answer is applied.
- One connection per window: the schema store is keyed to a single connection.
- **Releases are found in one place, named twice:** the `publish` section of `electron-builder.yml`
  (written into the app as `app-update.yml`) and `RELEASES_URL` in `shared/updates.ts` must name the
  same GitHub repository.

## UI work

Design tokens and shared controls are in `src/renderer/src/styles/index.css`.
`design-system/tableview/MASTER.md` documents the design system (palette, type, spacing, components,
motion, don'ts) — read it before changing how anything looks, and don't change it without the user's
say-so. Icons come from `lib/icons.ts`, drawn by `components/AppIcon.vue`.

## Claude Code setup in this repo

`.claude/skills/` contains UI UX Pro Max and the Superpowers skills, and `.claude/settings.json` runs a
SessionStart hook that loads `using-superpowers`. As project skills they are named without the
`superpowers:` prefix (e.g. `brainstorming`). Don't also install the Superpowers plugin, or everything
loads twice.
