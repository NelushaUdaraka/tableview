/**
 * A read-only connection, in the real UI against the test container.
 *
 * The list says which connection is read-only before it is opened, the form
 * keeps the setting, and once it is open nothing that writes is offered — no
 * Add row, Truncate and Drop greyed — while a script that writes is refused
 * whole and reads carry on. Then the window is gone round: the same writes
 * sent straight to the main process are refused there too, and the rows are
 * counted afterwards to show none of it happened. Last, the switch: the status
 * bar's padlock, the File menu, the list's menu and the form each turn it on at
 * once and ask before turning it off — and Escape on that question closes the
 * question, not the form under it.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9232
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-read-only`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-read-only`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('READ-ONLY E2E FAIL:', message)
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
const TABLE = 'read_only_e2e'

await send('Runtime.enable'); await send('Page.enable')
await waitFor(`!!document.querySelector('.titlebar')`, 'title bar')

// A table of its own, made over a writable connection, so the counts below
// are this suite's and nobody else's.
const setup = await ev(`
  (async () => {
    for (const c of await window.api.listConnections()) await window.api.deleteConnection(c.id)
    const writable = await window.api.saveConnection({ name: 'Writable', ...${JSON.stringify(SERVER)} })
    await window.api.saveConnection({ name: 'Production', readOnly: true, ...${JSON.stringify(SERVER)} })
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

// --- 1. the list says which one is read-only ---------------------------------
const rowOf = (name) =>
  `[...document.querySelectorAll('.row')].find(r => r.querySelector('.row__name')?.textContent.trim() === ${JSON.stringify(name)})`
await waitFor(`!!${rowOf('Production')}`, 'the read-only connection in the list')
steps.push({
  step: 'list',
  readOnlyBadge: await ev(`${rowOf('Production')}.querySelector('.row__readonly')?.textContent.trim() ?? null`),
  writableBadge: await ev(`${rowOf('Writable')}.querySelector('.row__readonly')?.textContent.trim() ?? null`)
})
check(steps.at(-1).readOnlyBadge === 'Read-only', 'the read-only connection is not marked in the list')
check(steps.at(-1).writableBadge === null, 'the writable connection is marked read-only')
await shot('01-list')

// --- 2. the form keeps the setting --------------------------------------------
await ev(`${rowOf('Production')}.querySelector('.row__menu').click()`)
await waitFor(`!!document.querySelector('.menu')`, 'the row menu')
await ev(`[...document.querySelectorAll('.menu .menu__item')].find(b => b.textContent.trim().startsWith('Edit')).click()`)
await waitFor(`!!document.querySelector('.form__tabs')`, 'the form')
const readOnlyBox = `[...document.querySelectorAll('.form .checkbox')].find(l => l.textContent.trim() === 'Read-only')?.querySelector('input')`
steps.push({ step: 'form', checked: await ev(`${readOnlyBox}?.checked ?? null`) })
check(steps.at(-1).checked === true, 'the form does not show the connection as read-only')
await shot('02-form')
await ev(`document.querySelector('.modal__close').click()`)
await waitFor(`!document.querySelector('.modal')`, 'the form to close')

// --- 3. connected, the window says so ------------------------------------------
await ev(`${rowOf('Production')}.querySelector('.row__connect').click()`)
await waitFor(`!!document.querySelector('.workspace')`, 'workspace', 45000)
await waitFor(`document.querySelectorAll('.sidebar .item').length > 0`, 'sidebar')
steps.push({
  step: 'connected',
  statusBar: await ev(`document.querySelector('.status__lock--on')?.textContent.trim() ?? null`),
  queryToolbar: await ev(`document.querySelector('.query__readonly')?.textContent.trim() ?? null`)
})
check(steps.at(-1).statusBar === 'Read-only', 'the status bar does not say the connection is read-only')
check(steps.at(-1).queryToolbar === 'Read-only', 'the query toolbar does not say the connection is read-only')

// --- 4. a script that writes is refused whole; reads go on ------------------
const runInEditor = async (sql) => {
  await ev(`document.querySelector('.cm-content').focus()`)
  // Ctrl+A, so what is typed next replaces the last script.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await send('Input.insertText', { text: sql })
  await delay(200)
  await ev(`[...document.querySelectorAll('.query__toolbar .btn')].find(b => b.textContent.includes('Run')).click()`)
}
await waitFor(`!!document.querySelector('.cm-content')`, 'the editor')
await runInEditor(`SELECT COUNT(*) AS n FROM dbo.${TABLE};\nDELETE FROM dbo.${TABLE};`)
await waitFor(`!!document.querySelector('.message--error')`, 'the refusal')
steps.push({
  step: 'write refused',
  title: await ev(`document.querySelector('.message--error .message__title')?.textContent.replace(/\\s+/g, ' ').trim()`),
  message: await ev(`document.querySelector('.message--error .message__text')?.textContent.trim()`)
})
check(steps.at(-1).title === 'Not run on a read-only connection, Line 2', 'the refusal is not titled as one')
check(steps.at(-1).message.startsWith('DELETE changes data'), 'the refusal does not say what it refused')
await shot('03-write-refused')

await runInEditor(`SELECT COUNT(*) AS n FROM dbo.${TABLE};`)
await waitFor(`document.querySelectorAll('.results__body .grid__row').length > 0`, 'the count')
const count = () => ev(`document.querySelector('.results__body .grid__row .grid__cell')?.textContent.trim()`)
steps.push({ step: 'read', count: await count() })
check(steps.at(-1).count === '3', 'the read did not run, or the rows were not all there')

// --- 5. the table offers nothing that writes ---------------------------------
const tableItem = `[...document.querySelectorAll('.sidebar .item__name')].find(e => e.textContent.trim() === '${TABLE}')?.closest('.item')`
await ev(`document.querySelector('.sidebar__db-btn[title^="Refresh"]').click()`)
await waitFor(`!!${tableItem}`, 'the table in the tree')
await ev(`${tableItem}.click()`)
await waitFor(`document.querySelectorAll('.grid__row').length > 0`, 'the rows')
steps.push({
  step: 'table',
  badge: await ev(`document.querySelector('.data__readonly')?.textContent.trim() ?? null`),
  toolbar: await ev(`[...document.querySelectorAll('.data__toolbar .btn')].map(b => b.textContent.trim())`)
})
check(steps.at(-1).badge === 'Read-only', 'the table does not say it is read-only')
check(!steps.at(-1).toolbar.includes('Add row'), 'the table offers Add row')

// Double-clicking a cell opens no editor, and nothing is staged.
await ev(`
  (() => {
    const cell = document.querySelectorAll('.grid__row')[0].querySelectorAll('.grid__cell')[1]
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()
`)
await delay(400)
steps.push({
  step: 'cell double-clicked',
  editor: await ev(`!!document.querySelector('.grid__editor')`),
  apply: await ev(`[...document.querySelectorAll('.data__toolbar .btn')].some(b => b.textContent.includes('Apply'))`)
})
check(!steps.at(-1).editor && !steps.at(-1).apply, 'a cell could be edited')
await shot('04-table')

// The tree's menu keeps Truncate and Drop, greyed, saying why.
await ev(`${tableItem}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 300 }))`)
await waitFor(`!!document.querySelector('.menu')`, 'the tree menu')
steps.push({
  step: 'tree menu',
  items: await ev(`
    [...document.querySelectorAll('.menu .menu__item')]
      .filter(b => /Truncate|Drop/.test(b.textContent))
      .map(b => ({ label: b.textContent.replace(/\\s+/g, ' ').trim(), disabled: b.disabled }))
  `)
})
check(
  steps.at(-1).items.length === 2 && steps.at(-1).items.every((item) => item.disabled && item.label.includes('Read-only')),
  'Truncate and Drop are not greyed out as read-only'
)
await shot('05-tree-menu')
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })

// The marks are drawn from the theme's tokens; a look at them on the light one.
await ev(`document.documentElement.setAttribute('data-theme', 'light')`)
await delay(300)
await shot('06-light-table')
await ev(`document.documentElement.setAttribute('data-theme', 'dark')`)

// --- 6. round the window: the main process refuses on its own ---------------
const bypass = await ev(`
  (async () => {
    const id = (await window.api.listConnections()).find(c => c.name === 'Production').id
    // contextBridge copies only the message of an error it carries, not its
    // code, so the message is what can be checked from here.
    const attempt = async (call) => {
      try { await call(); return 'went through' } catch (error) { return error.message }
    }
    return {
      applyChanges: await attempt(() => window.api.applyChanges({
        connectionId: id, schema: 'dbo', table: '${TABLE}',
        inserts: [], updates: [], deletes: [{ key: { id: 1 } }]
      })),
      truncate: await attempt(() => window.api.truncateTable(id, 'dbo', '${TABLE}')),
      drop: await attempt(() => window.api.dropObject(id, 'dbo', '${TABLE}', 'table')),
      rawFilter: await attempt(() => window.api.fetchTableData({
        connectionId: id, schema: 'dbo', table: '${TABLE}', offset: 0, limit: 10, sorts: [],
        filters: [], filterMode: 'raw', rawWhere: '1 = 1; DELETE FROM dbo.${TABLE}'
      })),
      count: (await window.api.runQuery({ connectionId: id, sql: 'SELECT COUNT(*) FROM dbo.${TABLE}' }))
        .statements[0].resultSets[0].rows[0][0]
    }
  })()
`)
steps.push({ step: 'round the window', ...bypass })
for (const call of ['applyChanges', 'truncate', 'drop', 'rawFilter']) {
  check(/this connection is read-only/i.test(bypass[call]), `${call} was not refused: ${bypass[call]}`)
}
check(bypass.count === 3, 'rows went missing')

// --- 7. switched off from the status bar, it asks first ------------------------
const lock = `document.querySelector('.status__lock')`
const locked = () => ev(`!!document.querySelector('.status__lock--on')`)
const escape = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
const asking = `[...document.querySelectorAll('.modal__title')].some(t => t.textContent.includes('Turn off read-only'))`
const answer = (label) =>
  ev(`[...document.querySelectorAll('.modal__foot .btn')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
const question = () =>
  ev(`(() => {
    const m = [...document.querySelectorAll('.modal')].at(-1)
    return {
      title: m.querySelector('.modal__title')?.textContent.trim(),
      subtitle: m.querySelector('.modal__subtitle')?.textContent.trim(),
      text: m.querySelector('.modal__body')?.textContent.replace(/\\s+/g, ' ').trim(),
      buttons: [...m.querySelectorAll('.modal__foot .btn')].map(b => b.textContent.trim()),
      focused: document.activeElement?.textContent.trim() ?? null
    }
  })()`)
const sql = (statement) =>
  ev(`(async () => {
    const id = (await window.api.listConnections()).find(c => c.name === 'Production').id
    const run = async (text) => (await window.api.runQuery({ connectionId: id, sql: text })).statements[0]
    const result = await run(${JSON.stringify(statement)})
    const count = (await run('SELECT COUNT(*) FROM dbo.${TABLE}')).resultSets[0].rows[0][0]
    return { error: result.error?.message ?? null, count }
  })()`)

await ev(`${lock}.click()`)
await waitFor(asking, 'the turn-off question')
// The safe answer takes the focus, so Enter keeps the lock on.
await waitFor(`document.activeElement?.textContent.trim() === 'Keep read-only'`, 'the safe answer to have the focus')
steps.push({ step: 'status bar: turning it off asks', ...(await question()) })
await shot('07-turn-off-question')
await escape()
await waitFor(`!document.querySelector('.modal')`, 'the question to go')
check(await locked(), 'Escape turned read-only off')

await ev(`${lock}.click()`)
await waitFor(asking, 'the question again')
await answer('Turn off read-only')
await waitFor(`!document.querySelector('.status__lock--on')`, 'the padlock to open')
steps.push({
  step: 'status bar: turned off',
  padlock: await ev(`${lock}.getAttribute('aria-pressed')`),
  queryBadge: await ev(`!!document.querySelector('.query__readonly')`),
  tableToolbar: await ev(`[...document.querySelectorAll('.data__toolbar .btn')].map(b => b.textContent.trim())`),
  saved: await ev(`(async () => (await window.api.listConnections()).find(c => c.name === 'Production').readOnly)()`),
  write: await sql(`DELETE FROM dbo.${TABLE} WHERE id = 3`)
})
check(steps.at(-1).tableToolbar.includes('Add row'), 'the table cannot be edited once read-only is off')
check(steps.at(-1).saved === false, 'turning it off was not saved')
check(steps.at(-1).write.error === null && steps.at(-1).write.count === 2, 'a write did not go through')
await shot('08-writable')

// --- 8. back on at once, without a question --------------------------------------
await ev(`${lock}.click()`)
await waitFor(`!!document.querySelector('.status__lock--on')`, 'the padlock to close')
check(!(await ev(`!!document.querySelector('.modal')`)), 'turning read-only on asked something')
steps.push({ step: 'status bar: back on', write: await sql(`DELETE FROM dbo.${TABLE} WHERE id = 2`) })
check(
  /read-only/.test(steps.at(-1).write.error ?? '') && steps.at(-1).write.count === 2,
  'a write went through once read-only was back on'
)

// The File menu holds the same switch, and asks the same question.
await ev(`[...document.querySelectorAll('.titlebar__menu')].find(b => b.textContent.trim() === 'File').click()`)
await waitFor(`!!document.querySelector('.titlebar__dropdown')`, 'the File menu')
await ev(`[...document.querySelectorAll('.titlebar__dropdown .titlebar__item')].find(i => i.textContent.includes('Toggle Read-only')).click()`)
await waitFor(asking, 'the question from the File menu')
await answer('Keep read-only')
await waitFor(`!document.querySelector('.modal')`, 'the question to go')
check(await locked(), 'Keep read-only turned it off')
steps.push({ step: 'file menu: same question, kept read-only' })

await ev(`document.querySelector('.status__btn--disconnect').click()`)
await waitFor(`!!document.querySelector('.row .row__buttons')`, 'the connection screen')

// --- 9. the list's menu switches it without connecting ----------------------------
const fromRowMenu = async (name, label) => {
  await ev(`${rowOf(name)}.querySelector('.row__menu').click()`)
  await waitFor(`!!document.querySelector('.menu')`, 'the row menu')
  const items = await ev(`[...document.querySelectorAll('.menu .menu__item')].map(b => b.textContent.trim())`)
  await ev(`[...document.querySelectorAll('.menu .menu__item')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  return items
}
const writableMenu = await fromRowMenu('Writable', 'Turn on read-only')
await waitFor(`!!${rowOf('Writable')}.querySelector('.row__readonly')`, 'the badge on Writable')
await fromRowMenu('Writable', 'Turn off read-only…')
await waitFor(asking, 'the question from the list')
await answer('Turn off read-only')
await waitFor(`!${rowOf('Writable')}.querySelector('.row__readonly')`, 'the badge to go')
steps.push({ step: 'list menu', writableMenu })
await shot('09-list-menu')

// --- 10. the form asks before unticking, and Escape closes only the question ------
await fromRowMenu('Production', 'Edit…')
await waitFor(`!!document.querySelector('.form__tabs')`, 'the form')
await ev(`${readOnlyBox}.click()`)
await waitFor(asking, 'the question over the form')
await shot('10-form-question')
await escape()
await waitFor(`document.querySelectorAll('.modal').length === 1`, 'the question alone to go')
steps.push({
  step: 'form: Escape on the question',
  formOpen: await ev(`!!document.querySelector('.form__tabs')`),
  stillTicked: await ev(`${readOnlyBox}.checked`)
})
check(steps.at(-1).formOpen, 'Escape on the question closed the form under it')
check(steps.at(-1).stillTicked, 'Escape on the question unticked read-only')

await ev(`${readOnlyBox}.click()`)
await waitFor(asking, 'the question again')
await answer('Turn off read-only')
await waitFor(`!(${asking})`, 'the question to go')
steps.push({ step: 'form: unticked once answered', ticked: await ev(`${readOnlyBox}.checked`) })
check(steps.at(-1).ticked === false, 'answering yes did not untick read-only')
// Cancel the form: nothing changes until Save.
await ev(`[...document.querySelectorAll('.form__foot .btn')].find(b => b.textContent.trim() === 'Cancel').click()`)
await waitFor(`!document.querySelector('.form__tabs')`, 'the form to close')
check(
  await ev(`(async () => (await window.api.listConnections()).find(c => c.name === 'Production').readOnly)()`),
  'cancelling the form changed the saved setting'
)

// --- tidy up ---------------------------------------------------------------------
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
  .replace(/\[ipc\] db:\w+ failed: Error: [^\n]*read-only[\s\S]*?code: 'READ_ONLY_CONNECTION'\n\}/g, '')
  .split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif/i.test(l))

console.log(JSON.stringify({ steps, rendererErrors }, null, 2))
socket.close(); child.kill('SIGKILL')
process.exit(rendererErrors.length === 0 ? 0 : 1)
