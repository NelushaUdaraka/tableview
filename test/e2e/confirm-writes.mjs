/**
 * A confirm-writes connection, in the real UI against the test container.
 *
 * The list, the status bar and the toolbars say the connection confirms its
 * writes. A script that only reads runs as it always did; one that writes
 * stops on a question listing each statement that writes, with its line and
 * database, and runs nothing until Run anyway — Cancel, where the focus
 * starts, and Escape send nothing. An UPDATE with no WHERE wants the table's
 * name typed before the button wakes. Apply in a table and Truncate from the
 * tree ask the same way, and the same writes sent straight to the main
 * process without the mark are refused there. Last, the switch beside
 * Read-only: off asks first, on does not, and read-only turned off on a
 * connection that confirms lands back on confirming without a question.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9234
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-confirm-writes`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-confirm-writes`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('CONFIRM-WRITES E2E FAIL:', message)
  console.log(JSON.stringify(steps, null, 2))
  process.stdout.write(logs.join('').split('\n').slice(-30).join('\n'))
  child.kill('SIGKILL')
  process.exit(1)
}
function check(condition, message) {
  if (!condition) bail(message)
}

let url
for (let i = 0; i < 60; i += 1) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (page) { url = page.webSocketDebuggerUrl; break }
  } catch { /* waiting */ }
  await delay(500)
}
if (!url) bail('devtools never appeared')

const socket = new WebSocket(url)
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
  }
})
await new Promise((r) => socket.addEventListener('open', r))
const send = (method, params = {}) => {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')) } }, 30000)
  })
}
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) bail('evaluate: ' + (r.exceptionDetails.exception?.description ?? ''))
  return r.result.value
}
const waitFor = async (expr, label, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await ev(`(() => { try { return ${expr} } catch { return null } })()`)
    if (v) return v
    await delay(200)
  }
  bail('timed out waiting for ' + label)
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'))
}

const SERVER = {
  host: '127.0.0.1', port: 11433, database: 'beekeeper_test', authType: 'sql',
  username: 'sa', password: 'Beekeeper#2024!', savePassword: true,
  options: { encrypt: true, trustServerCertificate: true }
}
const TABLE = 'confirm_writes_e2e'

await send('Runtime.enable'); await send('Page.enable')
await waitFor(`!!document.querySelector('.titlebar')`, 'title bar')

const setup = await ev(`
  (async () => {
    for (const c of await window.api.listConnections()) await window.api.deleteConnection(c.id)
    const writable = await window.api.saveConnection({ name: 'Writable', ...${JSON.stringify(SERVER)} })
    await window.api.saveConnection({ name: 'Guarded', confirmWrites: true, ...${JSON.stringify(SERVER)} })
    const status = await window.api.connect(writable.id)
    if (status.state !== 'connected') return 'could not connect: ' + (status.error?.message ?? status.state)
    const result = await window.api.runQuery({
      connectionId: writable.id,
      sql: "IF OBJECT_ID('dbo.${TABLE}') IS NOT NULL DROP TABLE dbo.${TABLE};\\n" +
        "CREATE TABLE dbo.${TABLE} (id int NOT NULL PRIMARY KEY, note nvarchar(50) NULL);\\n" +
        "INSERT INTO dbo.${TABLE} (id, note) VALUES (1, N'one'), (2, N'two'), (3, N'three');"
    })
    await window.api.disconnect(writable.id)
    return result.statements.find((s) => s.error)?.error.message ?? 'ok'
  })()
`)
check(setup === 'ok', `setting up the table failed: ${setup}`)
await ev('location.reload()')
await delay(1500)
await send('Runtime.enable')

const escape = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
const answer = (label) =>
  ev(`[...[...document.querySelectorAll('.modal')].at(-1).querySelectorAll('.modal__foot .btn')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
const question = () =>
  ev(`(() => {
    const m = [...document.querySelectorAll('.modal')].at(-1)
    return m && {
      kicker: m.querySelector('.kicker')?.textContent.trim(),
      title: m.querySelector('.modal__title')?.textContent.trim(),
      items: [...m.querySelectorAll('.write')].map(w => ({
        line: w.querySelector('.write__line')?.textContent.trim() ?? null,
        what: w.querySelector('.write__what')?.textContent.trim(),
        database: w.querySelector('.write__db')?.textContent.trim(),
        danger: !!w.querySelector('.write__input')
      })),
      buttons: [...m.querySelectorAll('.modal__foot .btn')].map(b => ({ label: b.textContent.trim(), disabled: b.disabled })),
      focused: document.activeElement?.textContent.trim() ?? null
    }
  })()`)
const confirming = `[...document.querySelectorAll('.kicker')].some(k => k.textContent.trim() === 'Confirm writes')`
const count = () =>
  ev(`(async () => {
    const id = (await window.api.listConnections()).find(c => c.name === 'Guarded').id
    const result = await window.api.runQuery({ connectionId: id, sql: 'SELECT COUNT(*) FROM dbo.${TABLE}' })
    return result.statements[0].resultSets[0].rows[0][0]
  })()`)

// --- 1. the list says which one confirms its writes ------------------------------
const rowOf = (name) =>
  `[...document.querySelectorAll('.row')].find(r => r.querySelector('.row__name')?.textContent.trim() === ${JSON.stringify(name)})`
await waitFor(`!!${rowOf('Guarded')}`, 'the guarded connection in the list')
steps.push({
  step: 'list',
  guarded: await ev(`${rowOf('Guarded')}.querySelector('.row__confirms')?.textContent.trim() ?? null`),
  writable: await ev(`${rowOf('Writable')}.querySelector('.row__confirms')?.textContent.trim() ?? null`),
  guardedReadOnly: await ev(`!!${rowOf('Guarded')}.querySelector('.row__readonly')`)
})
check(steps.at(-1).guarded === 'Confirm writes', 'the confirm-writes connection is not marked in the list')
check(steps.at(-1).writable === null, 'the writable connection is marked as confirming')
check(!steps.at(-1).guardedReadOnly, 'the confirm-writes connection is marked read-only')
await shot('01-list')

// --- 2. connected, the window says so ---------------------------------------------
await ev(`${rowOf('Guarded')}.querySelector('.row__connect').click()`)
await waitFor(`!!document.querySelector('.workspace')`, 'workspace', 45000)
await waitFor(`document.querySelectorAll('.sidebar .item').length > 0`, 'sidebar')
const confirmSwitch = `document.querySelector('.status__confirm')`
steps.push({
  step: 'connected',
  statusBar: await ev(`document.querySelector('.status__confirm--on')?.textContent.trim() ?? null`),
  switchState: await ev(`${confirmSwitch}?.getAttribute('aria-checked') ?? null`),
  readOnlyOn: await ev(`!!document.querySelector('.status__lock--on')`),
  queryToolbar: await ev(`document.querySelector('.query__confirms')?.textContent.trim() ?? null`)
})
check(steps.at(-1).statusBar === 'Confirm writes', 'the status bar does not say the connection confirms writes')
check(steps.at(-1).switchState === 'true', 'the confirm-writes switch is not on')
check(!steps.at(-1).readOnlyOn, 'the status bar says read-only')
check(steps.at(-1).queryToolbar === 'Confirm writes', 'the query toolbar does not say so')
await shot('02-connected')

// --- 3. a read runs without asking; a write asks first ----------------------------
const runInEditor = async (sql) => {
  await ev(`document.querySelector('.cm-content').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await send('Input.insertText', { text: sql })
  await delay(200)
  await ev(`[...document.querySelectorAll('.query__toolbar .btn')].find(b => b.textContent.includes('Run')).click()`)
}
await waitFor(`!!document.querySelector('.cm-content')`, 'the editor')
await runInEditor(`SELECT COUNT(*) AS n FROM dbo.${TABLE};`)
await waitFor(`document.querySelectorAll('.results__body .grid__row').length > 0`, 'the count')
check(!(await ev(confirming)), 'a script that only reads asked first')

await runInEditor(`SELECT COUNT(*) AS n FROM dbo.${TABLE};\nDELETE FROM dbo.${TABLE} WHERE id = 3;`)
await waitFor(confirming, 'the question before a write')
await waitFor(`document.activeElement?.textContent.trim() === 'Cancel'`, 'Cancel to have the focus')
steps.push({ step: 'write asks', ...(await question()) })
check(steps.at(-1).title === 'Run a statement that writes?', 'the question is not titled as one')
check(
  steps.at(-1).items.length === 1 &&
    steps.at(-1).items[0].line === 'Line 2' &&
    steps.at(-1).items[0].what === 'DELETE changes data' &&
    steps.at(-1).items[0].database === 'beekeeper_test' &&
    !steps.at(-1).items[0].danger,
  'the question does not list the DELETE, its line and its database'
)
await shot('03-write-question')
await escape()
await waitFor(`!(${confirming})`, 'the question to go')
check((await count()) === 3, 'Escape let the write through')

await ev(`[...document.querySelectorAll('.query__toolbar .btn')].find(b => b.textContent.includes('Run')).click()`)
await waitFor(confirming, 'the question again')
await answer('Run anyway')
await waitFor(`!(${confirming})`, 'the question to go')
await delay(500)
steps.push({ step: 'run anyway', count: await count() })
check(steps.at(-1).count === 2, 'Run anyway did not run the write')

// --- 4. an UPDATE with no WHERE wants the table's name typed -------------------------
await runInEditor(`UPDATE dbo.${TABLE} SET note = N'everything';`)
await waitFor(confirming, 'the question before an UPDATE with no WHERE')
const runAnyway = () =>
  ev(`[...[...document.querySelectorAll('.modal')].at(-1).querySelectorAll('.modal__foot .btn')].find(b => b.textContent.trim() === 'Run anyway').disabled`)
steps.push({ step: 'no WHERE', ...(await question()), disabledAtFirst: await runAnyway() })
check(steps.at(-1).items[0]?.danger, 'an UPDATE with no WHERE does not ask for the name')
check(steps.at(-1).disabledAtFirst === true, 'Run anyway is ready before the name is typed')
await ev(`document.querySelector('.write__input').focus()`)
await send('Input.insertText', { text: 'confirm_writes' })
await delay(150)
check((await runAnyway()) === true, 'Run anyway woke for part of the name')
await shot('04-type-the-name')
await ev(`document.querySelector('.write__input').select()`)
// Case does not count: names mostly do not either.
await send('Input.insertText', { text: TABLE.toUpperCase() })
await delay(150)
check((await runAnyway()) === false, 'Run anyway did not wake for the whole name')
await shot('05-name-typed')
await answer('Run anyway')
await waitFor(`!(${confirming})`, 'the question to go')

// --- 5. round the window: the main process refuses what is not marked confirmed -------
const bypass = await ev(`
  (async () => {
    const id = (await window.api.listConnections()).find(c => c.name === 'Guarded').id
    const attempt = async (call) => {
      try { await call(); return 'went through' } catch (error) { return error.message }
    }
    return {
      script: (await window.api.runQuery({ connectionId: id, sql: 'DELETE FROM dbo.${TABLE}' })).statements[0].error?.message ?? 'went through',
      applyChanges: await attempt(() => window.api.applyChanges({
        connectionId: id, schema: 'dbo', table: '${TABLE}',
        inserts: [], updates: [], deletes: [{ key: { id: 1 } }]
      })),
      truncate: await attempt(() => window.api.truncateTable(id, 'dbo', '${TABLE}')),
      drop: await attempt(() => window.api.dropObject(id, 'dbo', '${TABLE}', 'table')),
      rawFilter: await attempt(() => window.api.fetchTableData({
        connectionId: id, schema: 'dbo', table: '${TABLE}', offset: 0, limit: 10, sorts: [],
        filters: [], filterMode: 'raw', rawWhere: '1 = 1; DELETE FROM dbo.${TABLE}'
      }))
    }
  })()
`)
steps.push({ step: 'round the window', ...bypass, count: await count() })
for (const call of ['script', 'applyChanges', 'truncate', 'drop', 'rawFilter']) {
  check(/confirms writes first/.test(bypass[call]), `${call} was not refused: ${bypass[call]}`)
}
check(steps.at(-1).count === 2, 'rows went missing')

// --- 6. Apply in a table asks the same question ---------------------------------------
const tableItem = `[...document.querySelectorAll('.sidebar .item__name')].find(e => e.textContent.trim() === '${TABLE}')?.closest('.item')`
await ev(`document.querySelector('.sidebar__db-btn[title^="Refresh"]').click()`)
await waitFor(`!!${tableItem}`, 'the table in the tree')
await ev(`${tableItem}.click()`)
await waitFor(`document.querySelectorAll('.grid__row').length > 0`, 'the rows')
const noteColumn = await ev(`[...document.querySelectorAll('.grid__th-name')].findIndex(e => e.textContent.trim() === 'note')`)
await ev(`
  (() => {
    const cell = document.querySelectorAll('.grid__row')[0].querySelectorAll('.grid__cell')[${noteColumn}]
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()
`)
await waitFor(`!!document.querySelector('.grid__editor')`, 'cell editor')
await ev(`document.querySelector('.grid__editor').select()`)
await send('Input.insertText', { text: 'edited' })
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await delay(300)
steps.push({ step: 'table', badge: await ev(`document.querySelector('.data__confirms')?.textContent.trim() ?? null`) })
check(steps.at(-1).badge === 'Confirm writes', 'the table toolbar does not say so')
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.trim().startsWith('Apply')).click()`)
await waitFor(confirming, 'the question before Apply')
steps.push({ step: 'apply asks', ...(await question()) })
check(steps.at(-1).title === 'Apply these edits?', 'Apply did not ask')
check(
  steps.at(-1).items[0]?.what === `UPDATE changes 1 row of dbo.${TABLE}`,
  'the question does not say what Apply would send'
)
await shot('06-apply-question')
await answer('Cancel')
await waitFor(`!(${confirming})`, 'the question to go')
check(
  await ev(`[...document.querySelectorAll('.data__toolbar .btn')].some(b => b.textContent.trim().startsWith('Apply'))`),
  'Cancel let the staged edit go'
)
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.trim().startsWith('Apply')).click()`)
await waitFor(confirming, 'the question again')
await answer('Apply anyway')
await waitFor(`![...document.querySelectorAll('.data__toolbar .btn')].some(b => b.textContent.trim().startsWith('Apply'))`, 'the edit to apply')
const notes = await ev(`(async () => {
  const id = (await window.api.listConnections()).find(c => c.name === 'Guarded').id
  const result = await window.api.runQuery({ connectionId: id, sql: 'SELECT note FROM dbo.${TABLE} ORDER BY id' })
  return result.statements[0].resultSets[0].rows.map(r => r[0])
})()`)
steps.push({ step: 'applied', notes })
check(notes[0] === 'edited' && notes[1] === 'everything', 'the edit, or the earlier UPDATE, did not reach the table')

// --- 7. Truncate from the tree asks too, for the name -----------------------------------
await ev(`${tableItem}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 300 }))`)
await waitFor(`!!document.querySelector('.menu')`, 'the tree menu')
await ev(`[...document.querySelectorAll('.menu .menu__item')].find(b => b.textContent.includes('Truncate')).click()`)
await waitFor(confirming, 'the question before Truncate')
steps.push({ step: 'truncate asks', ...(await question()) })
check(
  steps.at(-1).title === `Truncate dbo.${TABLE}?` && steps.at(-1).items[0]?.danger,
  'Truncate did not ask for the name'
)
await shot('07-truncate-question')
await answer('Cancel')
await waitFor(`!(${confirming})`, 'the question to go')
check((await count()) === 2, 'Cancel truncated the table')

// --- 8. the switch: off asks, on does not --------------------------------------------
const stopping = `[...document.querySelectorAll('.modal__title')].some(t => t.textContent.includes('Stop confirming writes'))`
await ev(`${confirmSwitch}.click()`)
await waitFor(stopping, 'the turn-off question')
await waitFor(`document.activeElement?.textContent.trim() === 'Keep confirming'`, 'the safe answer to have the focus')
await shot('08-stop-question')
await escape()
await waitFor(`!document.querySelector('.modal')`, 'the question to go')
check((await ev(`${confirmSwitch}.getAttribute('aria-checked')`)) === 'true', 'Escape turned confirm writes off')

await ev(`${confirmSwitch}.click()`)
await waitFor(stopping, 'the question again')
await answer('Stop confirming')
await waitFor(`${confirmSwitch}.getAttribute('aria-checked') === 'false'`, 'the switch to go off')
// Back to the query tab, where a write now runs without a question.
await ev(`[...document.querySelectorAll('.tab')].find(t => t.textContent.includes('Query'))?.click()`)
await waitFor(`!!document.querySelector('.cm-content')`, 'the editor')
await runInEditor(`DELETE FROM dbo.${TABLE} WHERE id = 2;`)
await delay(800)
steps.push({ step: 'writable', asked: await ev(confirming), count: await count() })
check(!steps.at(-1).asked && steps.at(-1).count === 1, 'a write asked, or did not run, once confirm writes was off')

await ev(`${confirmSwitch}.click()`)
await waitFor(`${confirmSwitch}.getAttribute('aria-checked') === 'true'`, 'the switch to go on')
check(!(await ev(`!!document.querySelector('.modal')`)), 'turning confirm writes on asked something')

// --- 9. read-only on top, and off again, lands back on confirming ------------------------
await ev(`document.querySelector('.status__lock').click()`)
await waitFor(`!!document.querySelector('.status__lock--on')`, 'read-only to go on')
check(!(await ev(`!!document.querySelector('.status__confirm--on')`)), 'confirm writes still says it is in force under read-only')
await shot('09-read-only-over-confirm')
await ev(`document.querySelector('.status__lock').click()`)
await waitFor(`!document.querySelector('.status__lock--on')`, 'read-only to go off')
steps.push({
  step: 'read-only off',
  asked: await ev(`!!document.querySelector('.modal')`),
  confirming: await ev(`!!document.querySelector('.status__confirm--on')`),
  saved: await ev(`(async () => {
    const c = (await window.api.listConnections()).find(c => c.name === 'Guarded')
    return { readOnly: c.readOnly, confirmWrites: c.confirmWrites }
  })()`)
})
check(!steps.at(-1).asked, 'turning read-only off into confirm writes asked first')
check(steps.at(-1).confirming, 'read-only off did not land on confirm writes')
check(steps.at(-1).saved.readOnly === false && steps.at(-1).saved.confirmWrites === true, 'the settings were not saved')
await ev(`document.documentElement.setAttribute('data-theme', 'light')`)
await delay(150)
await shot('10-status-light')
await ev(`document.documentElement.setAttribute('data-theme', 'dark')`)

// --- tidy up ---------------------------------------------------------------------------
await ev(`document.querySelector('.status__btn--disconnect').click()`)
await waitFor(`!!document.querySelector('.row .row__buttons')`, 'the connection screen')
const cleanup = await ev(`
  (async () => {
    const writable = (await window.api.listConnections()).find(c => c.name === 'Writable')
    await window.api.connect(writable.id)
    const result = await window.api.runQuery({ connectionId: writable.id, sql: 'DROP TABLE dbo.${TABLE}' })
    await window.api.disconnect(writable.id)
    return result.statements[0].error?.message ?? 'ok'
  })()
`)
check(cleanup === 'ok', `could not drop the table: ${cleanup}`)

const rendererErrors = logs.join('')
  // Going round the window is meant to fail, and the main process logs each
  // refusal with its stack; those blocks, whole, are expected.
  .replace(/\[ipc\] db:\w+ failed: Error: [^\n]*confirms writes first[\s\S]*?code: 'WRITE_NOT_CONFIRMED'\n\}/g, '')
  .split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif/i.test(l))

console.log(JSON.stringify({ steps, rendererErrors }, null, 2))
socket.close(); child.kill('SIGKILL')
process.exit(rendererErrors.length === 0 ? 0 : 1)
