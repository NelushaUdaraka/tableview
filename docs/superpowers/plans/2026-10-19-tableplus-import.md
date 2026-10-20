# TablePlus Connection Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person paste a TablePlus *Copy as URL* link into TableView's New connection form and have it fill in a SQL Server connection, with the steps for getting that link shown in the app.

**Architecture:** A pure shared module, `src/shared/tableplus.ts`, recognises and parses TablePlus URLs and words what the panel says. The main process reads the clipboard through a new IPC channel and hands over only a SQL Server TablePlus URL. `TablePlusPanel.vue`, at the top of the New connection form's General tab, pastes, parses and has the form replace its fields; two menu entries open the form with the panel unfolded.

**Tech Stack:** Electron 44, Vue 3 `<script setup>` with Pinia, TypeScript, Vitest (`unit` project), CDP-driven end-to-end scripts in `test/e2e/`.

**Spec:** `docs/superpowers/specs/2026-10-19-tableplus-import-design.md`

## Global Constraints

- SQL Server only. Accepted schemes: `sqlserver` and `microsoftsqlserver`, each optionally with `+ssh`, matched case-insensitively. TablePlus for Windows writes `microsoftsqlserver://`.
- The clipboard is read in the main process. Only a SQL Server TablePlus URL reaches the window; anything else, another database's TablePlus URL included, is refused there with a message.
- Nothing is saved until the person presses Save, and saving goes through the existing `connections.save` path. An import never changes an existing connection.
- The password appears only in the masked password field and is stored only by the existing save path.
- A paste replaces the whole form, starting from the form's `blank()` state; a second paste replaces the first.
- The panel shows only for a new connection (the form's `connection` prop is `null`): never when editing, never on a duplicate.
- Defaults that stand: port 1433, SSH port 22, `DEFAULT_SQLSERVER_OPTIONS` (encrypt and trust server certificate on), `authType: 'sql'`, `savePassword: true`. `tLSMode` and every parameter Task 1 does not name are ignored, never refused.
- UI follows `design-system/tableview/MASTER.md`: tokens and shared classes from `src/renderer/src/styles/index.css` only (no hex in components); icons through `AppIcon` from `lib/icons.ts` (`clipboard-paste`, `circle-check`, `triangle-alert`, `chevron-right`, `chevron-down` exist); sentence-case labels; class names and button text that `test/e2e/*.mjs` read stay as they are.
- Messages use the codebase's voice: "does not" rather than "doesn't", and curly quotes around a name (“App DEV”).
- Setup: a fresh checkout has no `node_modules`. Run `npm install` once; if Electron is missing, `npx install-electron`. The e2e suite needs Xvfb and Electron's Linux libraries (README → Testing → End-to-end).

## Review Focus

1. A URL with no password: nothing is stored as a password (`hasSavedPassword` stays false), so TableView asks for one at connect instead of saving an empty one. Pinned in Task 3, e2e step 7.
2. Text copied with whitespace or a newline around it, and a scheme in another case (`SQLServer://`): accepted. Pinned in Task 1, test 2 and the clipboard tests.
3. Pasting into a form that was already partly typed: every field is replaced, and one the URL lacks goes back to blank. Pinned in Task 3, e2e steps 2, 4 and 7.
4. A `%` in a password that is not a valid escape (`ab%zz`): kept as written; the paste never throws a `URIError`. Pinned in Task 1, test 5.
5. A saved name that differs only in case or surrounding spaces (` app dev `): still warned about. Pinned in Task 2.

---

### Task 1: Recognise and parse a TablePlus URL

**Files:**
- Create: `src/shared/tableplus.ts`
- Modify: `src/shared/accent.ts` (add `nearestSwatch`)
- Test: `test/unit/tableplus.test.ts` (new), `test/unit/accent.test.ts`

**Interfaces:**
- Consumes: `ACCENT_SWATCHES`, `AccentSwatch`, `parseHex` (`src/shared/accent.ts`); `DEFAULT_SSH_CONFIG`, `SshConfig` (`src/shared/types.ts`).
- Produces:
  ```ts
  // src/shared/accent.ts
  export function nearestSwatch(value: string | undefined | null): AccentSwatch | null

  // src/shared/tableplus.ts
  export interface TablePlusConnection {
    name: string
    host: string
    port: number
    database: string
    username: string
    password: string
    /** A swatch's hex from ACCENT_SWATCHES, or '' for none. */
    color: string
    /** The TablePlus tag with its first letter capitalised, or '' for none. */
    group: string
    readOnly: boolean
    /** `{ ...DEFAULT_SSH_CONFIG }` when the URL has no tunnel. */
    ssh: SshConfig
  }
  export interface TablePlusImport {
    connection: TablePlusConnection
    /** The matched swatch's label, e.g. 'Blue'; null when no colour came across. */
    colourLabel: string | null
    /** A `+ssh` URL with `usePrivateKey=true`: the key file is not in the URL. */
    keyFileNeeded: boolean
  }
  /** Throws an Error whose message is one of the three below. */
  export function parseTablePlusUrl(text: string): TablePlusImport
  /** The main process's gate: the trimmed URL, or an Error whose message is one of the three below. */
  export function tablePlusUrlFromClipboard(text: string): string
  ```
  Messages (exact):
  - empty: `The clipboard is empty. In TablePlus, right-click the connection and choose Copy as URL.`
  - not TablePlus: `The clipboard does not hold a TablePlus URL. In TablePlus, right-click the connection and choose Copy as URL, then paste again.`
  - another database: `` `That is a ${engine} connection. TableView only connects to SQL Server.` ``

- [ ] **Step 1: Write the failing tests**

In `test/unit/accent.test.ts`, add `describe('nearestSwatch')`:
```ts
it('matches a colour to the nearest of the offered swatches', () => {
  expect(nearestSwatch('005392')?.hex).toBe('#1971c2') // TablePlus's dark blue → Blue
  expect(nearestSwatch('#E03131')?.label).toBe('Red') // an exact swatch, # and case either way
  expect(nearestSwatch('808080')?.label).toBe('Slate')
  expect(nearestSwatch('3e63dd')?.label).toBe('Blue') // never the empty default swatch
})
it('has nothing to offer for something that is not a colour', () => {
  for (const value of ['', 'blue', '12345', undefined, null]) expect(nearestSwatch(value)).toBeNull()
})
```

Create `test/unit/tableplus.test.ts` with this fixture (the user's Windows URL, every secret and name replaced):
```ts
const WINDOWS_URL =
  'microsoftsqlserver://appuser:Fake%7Bpw%27%7Cx%3B%29y~%60.z%3E9@127.0.0.1/appdb?statusColor=005392&env=development&name=App%20DEV&tLSMode=0&usePrivateKey=false&safeModeLevel=0&advancedSafeModeLevel=0&driverVersion=0&showSystemSchemas=0&driverVersion=0&lazyload=False'
```
and these tests in `describe('parseTablePlusUrl')`:
1. `fills in everything the Windows URL carries`:
   ```ts
   expect(parseTablePlusUrl(WINDOWS_URL)).toEqual({
     connection: {
       name: 'App DEV', host: '127.0.0.1', port: 1433, database: 'appdb',
       username: 'appuser', password: "Fake{pw'|x;)y~`.z>9",
       color: '#1971c2', group: 'Development', readOnly: false,
       ssh: { ...DEFAULT_SSH_CONFIG }
     },
     colourLabel: 'Blue',
     keyFileNeeded: false
   })
   ```
2. `takes the sqlserver scheme too, in any case, with whitespace round it`: `parseTablePlusUrl('  \nSQLServer://sa:pw@db.example.com:14330/sales?name=Sales\n').connection` matches `{ name: 'Sales', host: 'db.example.com', port: 14330, database: 'sales', username: 'sa', password: 'pw' }`.
3. `falls back when TablePlus left things out`: `parseTablePlusUrl('sqlserver://db.example.com')` gives `name: 'db.example.com'`, `port: 1433`, `database: ''`, `username: ''`, `password: ''`, `color: ''`, `group: ''`, `readOnly: false`, `colourLabel: null`; and `parseTablePlusUrl('sqlserver://h?statusColor=nothex').connection.color` is `''`.
4. `decodes the login without turning + into a space`: `parseTablePlusUrl('sqlserver://us%40er:p%40ss%3Aw%2Fo%3Fr%23d%25+%20x@h/db').connection` has `username: 'us@er'`, `password: 'p@ss:w/o?r#d%+ x'`.
5. `keeps a % that is not an escape instead of failing`: `parseTablePlusUrl('sqlserver://u:ab%zz@h/db').connection.password` is `'ab%zz'`.
6. `reads a space in the name written either way`: `name=App%20DEV` and `name=App+DEV` both give `'App DEV'`.
7. `files the tag as a group`: `env=production` → `'Production'`, `env=staging` → `'Staging'`, `env=client%20work` → `'Client work'`, `env=` → `''`.
8. `arrives read-only for any safe mode but Silent`: `safeModeLevel`/`advancedSafeModeLevel` of `0/0` → `false`; `1/0`, `1/1`, `2/0`, `2/1` → `true`; both absent → `false`.
9. `brings an SSH tunnel with a password`: `parseTablePlusUrl('sqlserver+ssh://deploy:ssh%40pw@bastion.example.com:2222/appuser:db%2Fpw@10.0.0.5:1433/appdb?name=Via%20SSH')` has `connection.ssh` equal to `{ ...DEFAULT_SSH_CONFIG, enabled: true, host: 'bastion.example.com', port: 2222, username: 'deploy', authMode: 'password', password: 'ssh@pw' }`, `host: '10.0.0.5'`, `port: 1433`, `username: 'appuser'`, `password: 'db/pw'`, `database: 'appdb'`, `keyFileNeeded: false`.
10. `asks for the key file a key tunnel needs, and takes the password as its passphrase`: `'sqlserver+ssh://deploy:keypass@bastion.example.com/appuser:pw@10.0.0.5/appdb?usePrivateKey=true'` has `ssh` equal to `{ ...DEFAULT_SSH_CONFIG, enabled: true, host: 'bastion.example.com', port: 22, username: 'deploy', authMode: 'privateKey', privateKeyPath: '', passphrase: 'keypass' }` and `keyFileNeeded: true`.
11. `uses the SSH agent with neither a key nor a password`: `'sqlserver+ssh://deploy@bastion.example.com/appuser:pw@10.0.0.5/appdb'` has `ssh.authMode: 'agent'`, `ssh.enabled: true`, `keyFileNeeded: false`.
12. `turns another database down by name`: `postgres://u:pw@h/db` throws `'That is a PostgreSQL connection. TableView only connects to SQL Server.'`; `mysql+ssh://a@b/c:d@e/f` throws the same sentence naming `MySQL`; `mongodb://h` names `MongoDB`.
13. `turns down anything that is not a TablePlus URL`: `'hunter2'`, `'https://tableplus.com'`, `'sqlserver:/one-slash'` and `'Server=db;Database=x;'` each throw `/does not hold a TablePlus URL/`.

And `describe('tablePlusUrlFromClipboard')`:
- `hands over the URL, trimmed`: `tablePlusUrlFromClipboard(' ' + WINDOWS_URL + '\n')` is `WINDOWS_URL`.
- `says the clipboard is empty`: `'  \n '` throws the empty message exactly.
- `keeps everything else back`: `'hunter2'` throws the not-TablePlus message exactly; `'postgres://u:pw@h/db'` throws `/PostgreSQL/`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project unit test/unit/tableplus.test.ts test/unit/accent.test.ts`
Expected: FAIL: `tableplus` cannot be resolved and `nearestSwatch` is not exported.

- [ ] **Step 3: Implement `nearestSwatch(value)` in `src/shared/accent.ts`**

The swatch with a non-empty `hex` at the smallest Euclidean RGB distance from `parseHex(value)`; `null` when `parseHex` returns `null`.

- [ ] **Step 4: Implement `parseTablePlusUrl` and `tablePlusUrlFromClipboard` in `src/shared/tableplus.ts`**

The other engines TablePlus names, from its docs (exact):
```ts
const OTHER_ENGINES: Record<string, string> = {
  postgresql: 'PostgreSQL', postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB',
  redshift: 'Amazon Redshift', cockroach: 'CockroachDB', greenplum: 'Greenplum',
  vertica: 'Vertica', oracle: 'Oracle', clickhouse: 'ClickHouse', cassandra: 'Cassandra',
  redis: 'Redis', mongodb: 'MongoDB', elasticsearch: 'Elasticsearch', duckdb: 'DuckDB',
  d1: 'Cloudflare D1', cloudflared1: 'Cloudflare D1', sqlite: 'SQLite',
  snowflake: 'Snowflake', bigquery: 'BigQuery', libsql: 'libSQL'
}
```
Approach:
- Trim, then match `/^([a-z][a-z0-9.+-]*):\/\//i`; no match means not TablePlus. Lower-case the scheme and strip a trailing `+ssh`. `sqlserver` and `microsoftsqlserver` go on; an `OTHER_ENGINES` key gives the refusal naming it; anything else is not TablePlus.
- Parse with `new URL(text)`. Read parameters from `url.searchParams`, so `+` and `%20` both decode to a space. Decode the user, password and path segments with `decodeURIComponent`, falling back to the raw text on `URIError`.
- For `+ssh`, the outer authority is the SSH server, and `url.pathname.slice(1)` holds `user:password@host:port/database`. Parse that again as `new URL('tableplus://' + inner)`.
- Field rules are in the spec's "What fills in" table:
  - `safeModeLevel` → read-only when `Number(value) > 0`.
  - `usePrivateKey` → a key tunnel when the value equals `'true'`, ignoring case.
  - `env` → group: trimmed, first letter upper-cased.
  - `statusColor` → colour: `nearestSwatch`, which supplies both `color` and `colourLabel`.
- `tablePlusUrlFromClipboard`: throw the empty message for blank text, call `parseTablePlusUrl` (which throws the other two), and return the trimmed text.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run --project unit test/unit/tableplus.test.ts test/unit/accent.test.ts && npm run typecheck:node`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/tableplus.ts src/shared/accent.ts test/unit/tableplus.test.ts test/unit/accent.test.ts
git commit -m "Parse TablePlus connection URLs"
```

### Task 2: What the panel says after a paste

**Files:**
- Modify: `src/shared/tableplus.ts`
- Test: `test/unit/tableplus.test.ts`

**Interfaces:**
- Consumes: `TablePlusImport`, `parseTablePlusUrl` (Task 1).
- Produces:
  ```ts
  export interface TablePlusFormState {
    /** The name in the form now: the person may have changed it since the paste. */
    name: string
    savedNames: readonly string[]
    keyFileChosen: boolean
  }
  export interface TablePlusStatus {
    summary: string
    warnings: string[]
  }
  export function tablePlusStatus(result: TablePlusImport, state: TablePlusFormState): TablePlusStatus
  ```

- [ ] **Step 1: Write the failing tests** in `describe('tablePlusStatus')`, with `state = { name: result.connection.name, savedNames: [], keyFileChosen: false }` unless a test says otherwise:
1. `sums up what came across`: for `WINDOWS_URL` with `name: 'App DEV'`, the result is `{ summary: 'Filled in from TablePlus · password included · colour blue', warnings: [] }`. The tunnel URL from Task 1 test 9 gives a summary ending `' · SSH tunnel'`. `sqlserver://appuser@h/db` gives exactly `'Filled in from TablePlus'`.
2. `warns about a name already saved, however it is spelt`: `savedNames: [' app dev ']` with `name: 'App DEV'` gives a first warning of exactly `'You already have a connection called “App DEV”. Saving adds this one beside it; that one stays as it is.'`. With `name: 'App DEV 2'` there is no such warning.
3. `says a safe mode arrived as read-only`: `safeModeLevel=2` includes `'TablePlus had a safe mode on for this one, so it arrives read-only. Untick Read-only before saving if you do not want that.'`
4. `asks for the key file until one is chosen`: the Task 1 test 10 URL includes `'Choose the SSH key file on the Tunnel tab: TablePlus does not put it in the URL.'` when `keyFileChosen: false`, and not when it is `true`.
5. `says when no login came with the URL`: `sqlserver://h/db` includes `'No login came with this URL. If the connection signs in with Windows or Microsoft Entra ID, set that up by hand before saving.'`
6. `puts the warnings in one order`: `'sqlserver+ssh://deploy@b/h/db?name=App%20DEV&usePrivateKey=true&safeModeLevel=1'` with `savedNames: ['App DEV']` gives four warnings in this order: same name, read-only, key file, no login.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project unit test/unit/tableplus.test.ts`
Expected: FAIL: `tablePlusStatus` is not exported.

- [ ] **Step 3: Implement `tablePlusStatus`**

The summary is `'Filled in from TablePlus'` followed by whichever of these apply, joined with `' · '`:
- `'password included'`
- `` `colour ${label.toLowerCase()}` ``
- `'SSH tunnel'`

Names are compared trimmed and case-insensitively, as `planImport` compares them. The warning quotes `state.name.trim()`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project unit test/unit/tableplus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/tableplus.ts test/unit/tableplus.test.ts
git commit -m "Word what a TablePlus paste brought across"
```

### Task 3: Paste a TablePlus URL into a new connection

**Files:**
- Modify: `src/shared/ipc.ts` (`CHANNELS`, `RendererApi`), `src/main/ipc/index.ts` (beside `clipboardAwsCredentials`), `src/preload/index.ts`
- Create: `src/renderer/src/components/TablePlusPanel.vue`
- Modify: `src/renderer/src/components/ConnectionForm.vue`, `src/renderer/src/views/ConnectionScreen.vue`
- Test: `test/e2e/connections.mjs`

**Interfaces:**
- Consumes: `tablePlusUrlFromClipboard`, `parseTablePlusUrl`, `TablePlusImport` (Task 1); `tablePlusStatus` (Task 2).
- Produces:
  - `CHANNELS.clipboardTablePlusUrl = 'clipboard:tablePlusUrl'` and `RendererApi.readTablePlusUrlFromClipboard(): Promise<string>`.
  - `TablePlusPanel.vue`:
    - Props: `{ open: boolean; name: string; savedNames: readonly string[]; keyFileChosen: boolean }`.
    - Emits: `fill(result: TablePlusImport)`.
    - Classes the e2e reads: `.tpanel`, `.tpanel__toggle`, `.tpanel__steps`, `.tpanel__paste`, `.tpanel__status`, `.tpanel__warnings`.
  - `ConnectionForm.vue` gains two props: `tablePlusOpen?: boolean` (the panel starts unfolded) and `savedNames?: string[]`.

- [ ] **Step 1: Write the failing e2e section**

Append a `// --- from TablePlus ---` section to `test/e2e/connections.mjs`, after the toasts section and before the `rendererErrors` summary. Use the suite's `ev`, `waitFor`, `setInput`, `check` and `shot`, plus:
```js
const TP_URL = '…' // the same string as WINDOWS_URL in test/unit/tableplus.test.ts
const val = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.value ?? null`)
const tpText = () => ev(`document.querySelector('.tpanel')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`)
const pasteTP = async (text) => {
  await ev(`window.api.copyToClipboard(${JSON.stringify(text)})`)
  await ev(`document.querySelector('.tpanel__paste').click()`)
}
const newConnection = () => ev(`document.querySelector('.screen__actions .btn--primary').click()`)
const saveForm = async () => {
  await ev(`document.querySelector('.form button[type=submit]').click()`)
  await waitFor(`!document.querySelector('.form__tabs')`, 'the form to close')
}
```
The form's fields are found by placeholder. Two selectors rely on the General section coming first in the DOM; the Tunnel section's fields stay in the DOM under `v-show`.
- name: `input[placeholder="Production reporting"]`
- server: `placeholder="localhost"`
- port: the first `.form__section input[type=number]`
- database: `placeholder="(default)"`
- user: `placeholder="sa"`
- password: the first `.form input[type=password]`
- group: `placeholder="(none)"`

Steps:
1. `newConnection()`, then wait for `.tpanel`. `check('folded on a plain new connection', !!document.querySelector('.tpanel__steps'), false)`, and check that `.tpanel__toggle` exists.
2. Set the name to `'Typed first'` and the group to `'Typed group'`. `pasteTP('hunter2 is not a URL')`, then wait for `tpText()` to include `'does not hold a TablePlus URL'`. Check that both typed values are still there.
3. `pasteTP('postgres://u:pw@db.example.com:5432/app?name=Analytics')`, then wait for `'That is a PostgreSQL connection'`. Check that both typed values are still there.
4. `pasteTP(TP_URL)`, then wait for `'Filled in from TablePlus'`. Check:
   - name `'App DEV'`, server `'127.0.0.1'`, port `'1433'`, database `'appdb'`, user `'appuser'`, group `'Development'`.
   - The password input's value is `"Fake{pw'|x;)y~`.z>9"` and its `type` is `'password'`.
   - `.swatch[aria-label="Blue"]` has `aria-pressed` `'true'`.
   - `.form__toggle input[type=checkbox]` is not checked.
   - `.tpanel__status` text is `'Filled in from TablePlus · password included · colour blue'`.
   - `listConnections()` holds no `App DEV` yet: nothing is saved before Save.
5. `saveForm()`. Read back `(await window.api.listConnections()).filter((c) => c.name === 'App DEV')`, mapped to `{ host, port, database, username, color, group, readOnly: c.readOnly === true, hasSavedPassword, passwordInWindow: c.password !== undefined }`. Check it equals `[{ host: '127.0.0.1', port: 1433, database: 'appdb', username: 'appuser', color: '#1971c2', group: 'Development', readOnly: false, hasSavedPassword: true, passwordInWindow: false }]`.
6. `newConnection()`, then `pasteTP(TP_URL)`. Check that `tpText()` includes `'You already have a connection called “App DEV”'`. `saveForm()`. Check there are now two `App DEV` rows, and that the first by `createdAt` is unchanged from step 5.
7. `newConnection()`, then set the group to `'Typed group'`. `pasteTP('microsoftsqlserver://appuser@127.0.0.1/appdb?name=No%20Password')`. Check the group field is `''`. `saveForm()`. Check that `No Password` has `hasSavedPassword: false` and `group` of `''` or `undefined`.
8. `newConnection()`, then `pasteTP('sqlserver+ssh://deploy:keypass@bastion.example.com/appuser:pw@10.0.0.5/appdb?name=Via%20Key&usePrivateKey=true')`. Check that `tpText()` includes `'Choose the SSH key file on the Tunnel tab'`. Click the `.form__tab` reading `Tunnel` and check its text includes `'TablePlus does not put the key file in the URL'`. Click Cancel in `.form__foot`, then `shot('08-tableplus')`.

Add `.filter((l) => !l.includes('clipboard:tablePlusUrl failed'))` to `rendererErrors`, as `ssm-form.mjs` does for the AWS channel; the refused pastes log there by design.

- [ ] **Step 2: Run the suite to see it fail**

Run: `scripts/e2e.sh connections`
Expected: exits 1 with `CONNECTIONS E2E FAIL: timed out waiting for` the panel.

- [ ] **Step 3: Add the clipboard channel**

- `src/shared/ipc.ts`: the channel, plus the method with a doc comment shaped like `readAwsCredentialsFromClipboard`'s.
- `src/main/ipc/index.ts`: `handle(CHANNELS.clipboardTablePlusUrl, async () => tablePlusUrlFromClipboard(await clipboard.readText()))`.
- `src/preload/index.ts`: `readTablePlusUrlFromClipboard: () => invoke(CHANNELS.clipboardTablePlusUrl)`.

- [ ] **Step 4: Create `TablePlusPanel.vue`**

The copy is fixed:
- Unfolded:
  - heading `Bringing this over from TablePlus?`
  - `ol.tpanel__steps`: `In TablePlus, right-click the connection in the start window.` / `Choose <strong>Copy as URL</strong>.` / `Come back and press Paste URL. Everything below fills itself in.`
- Folded:
  - `Coming from TablePlus? Paste its URL.`
  - a `.tpanel__toggle` button `How?` with `aria-expanded`, which unfolds the steps.
- Both: a `.btn.btn--sm.tpanel__paste` button reading `Paste URL`, with the `clipboard-paste` icon (a `.spinner` while pasting).

The paste calls `api.readTablePlusUrlFromClipboard()`, then `parseTablePlusUrl`. It keeps the result and emits `fill`. On an error it keeps `error.message`, as `AwsCredentialsBox.vue` does, and emits nothing.

- `.tpanel__status` (`aria-live="polite"`) shows the error (`error-text`), or `tablePlusStatus(result, { name, savedNames, keyFileChosen }).summary` with a `circle-check` icon.
- `ul.tpanel__warnings` lists the warnings, each with `triangle-alert` (`warn-text`).
- Styling: a raised block (`--bg-raised`, `--border-subtle`, `--radius`) as in mockup A.

- [ ] **Step 5: Wire it into `ConnectionForm.vue`**

- Move the reset at the top of the `props.connection` watcher into `resetForm()`, and call that there.
- Add `fromTablePlus = ref<TablePlusImport | null>(null)`, cleared by `resetForm()`.
- `applyTablePlus(result)`:
  1. `resetForm()`
  2. `Object.assign(form, { ...result.connection, ssh: { ...result.connection.ssh } })`
  3. `passwordTouched = result.connection.password !== ''` (false for a URL with no password, so `payload()` leaves the password out and nothing is stored)
  4. `sshPasswordTouched = Boolean(ssh.password)`
  5. `sshPassphraseTouched = Boolean(ssh.passphrase)`
  6. `fromTablePlus = result`
- Make the first child of the General section `<TablePlusPanel v-if="!connection" :open="tablePlusOpen ?? false" :name="form.name" :saved-names="savedNames ?? []" :key-file-chosen="Boolean(form.ssh?.privateKeyPath?.trim())" @fill="applyTablePlus" />`.
- Under *Private key file*, add `<span v-if="keyFileMissing" class="field__hint warn-text">TablePlus does not put the key file in the URL. Choose it here.</span>`, where `keyFileMissing` is true when `fromTablePlus` needed a key, `usesSshKey` is true, and the key path is empty.

- [ ] **Step 6: Pass the saved names from `ConnectionScreen.vue`**

Add `:saved-names="connections.saved.map((entry) => entry.name)"` to `<ConnectionForm>`.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test && scripts/e2e.sh connections`
Expected:
- Typecheck is clean.
- All unit tests pass.
- The e2e suite exits 0 and prints `"failures": []` and `"rendererErrors": []`.

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/index.ts src/preload/index.ts src/renderer/src/components/TablePlusPanel.vue src/renderer/src/components/ConnectionForm.vue src/renderer/src/views/ConnectionScreen.vue test/e2e/connections.mjs
git commit -m "Fill a new connection from a pasted TablePlus URL"
```

### Task 4: Import from TablePlus in the ⋮ menu and the File menu

**Files:**
- Modify: `src/shared/menu.ts`, `src/renderer/src/views/ConnectionScreen.vue`, `README.md`
- Test: `test/unit/menu.test.ts`, `test/e2e/connections.mjs`

**Interfaces:**
- Consumes: `ConnectionForm`'s `tablePlusOpen` prop (Task 3).
- Produces: `MenuAction` gains `'connections:import-tableplus'`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/menu.test.ts`:
```ts
it('offers Import from TablePlus in the File menu, right after Import Connections', () => {
  const file = buildMenuModel('win32').find((menu) => menu.label === 'File')!.items
  const at = file.findIndex((item) => item.action === 'connections:import')
  expect(file[at + 1]).toMatchObject({ label: 'Import from TablePlus…', action: 'connections:import-tableplus' })
})
```
At the start of the e2e TablePlus section:
- Click `.screen__more` and wait for `.menu`. Check its `.menu__item` texts equal `['Import connections…', 'Import from TablePlus…', 'Export connections…']`.
- Click *Import from TablePlus…* and wait for `.tpanel__steps`. Check there are 3 `.tpanel__steps li`, and that the `.modal .kicker` text is `'New connection'`. Cancel.
- Open `rowMenu('Local dev', 'Edit')` and check there is no `.tpanel`. Cancel.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit test/unit/menu.test.ts && scripts/e2e.sh connections`
Expected: the menu test fails on `undefined` and the e2e on the menu items.

- [ ] **Step 3: Add the menu entries**

- `src/shared/menu.ts`: add the action to `MenuAction`, and add `{ label: 'Import from TablePlus…', action: 'connections:import-tableplus' }` after *Import Connections…*.
- `ConnectionScreen.vue`:
  - `const tablePlusOpen = ref(false)`.
  - `startNew()` sets it to `false`. A new `startTablePlusImport()` calls `startNew()` and then sets it to `true`. Use a separate function rather than a `startNew` parameter, because `@click="startNew"` passes the click event, which would be truthy.
  - `transferItems` gets `{ label: 'Import from TablePlus…', action: 'import-tableplus' }` between import and export.
  - `onMenuSelect` handles `'import-tableplus'`, and the `onMenuAction` listener handles `'connections:import-tableplus'`.
  - Pass `:table-plus-open="tablePlusOpen"` to `<ConnectionForm>`.
- `WorkspaceView.vue` needs nothing: *New Connection…* is handled only on the connection screen too.

- [ ] **Step 4: Update `README.md`**

Under *What's in phase 1 → Connections*, add a bullet in the README's voice. It must cover:
- where *Import from TablePlus…* lives;
- the three steps;
- what fills in;
- that nothing is saved before *Save*;
- that a saved name is left alone;
- that a safe mode arrives read-only;
- that the clipboard is read in the main process and hands over only a SQL Server TablePlus URL.

Then extend the e2e list's **connections** entry with one sentence on the TablePlus checks, and set the unit-test count in the Testing table to the total `npm test` prints.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && scripts/e2e.sh connections`
Expected: typecheck clean; all unit tests pass; the e2e suite exits 0 with `"failures": []` and `"rendererErrors": []`.

- [ ] **Step 6: Commit**

```bash
git add src/shared/menu.ts src/renderer/src/views/ConnectionScreen.vue README.md test/unit/menu.test.ts test/e2e/connections.mjs
git commit -m "Offer Import from TablePlus in the menus"
```
