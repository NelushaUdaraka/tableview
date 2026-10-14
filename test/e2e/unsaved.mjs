/**
 * Unsaved work, asked about before anything that would throw it away:
 * disconnecting, closing the window, and quitting — for a table's staged
 * edits and a routine's unsaved changes alike. Nothing unsaved, nothing
 * asked; Cancel keeps everything; and once every question has been answered
 * the window really does close, and the app goes with it.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9231
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-unsaved`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-unsaved`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))
let exited = false
child.on('exit', () => {
  exited = true
})

const steps = []
function bail(message) {
  console.log('UNSAVED E2E FAIL:', message)
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
const key = async (keyName, code, keyCode, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key: keyName, code, windowsVirtualKeyCode: keyCode })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: keyName, code, windowsVirtualKeyCode: keyCode })
}

await send('Runtime.enable'); await send('Page.enable')
await waitFor(`!!document.querySelector('.titlebar')`, 'title bar')

await ev(`
  (async () => {
    for (const c of await window.api.listConnections()) await window.api.deleteConnection(c.id)
    await window.api.saveConnection({
      name: 'Docker SQL Server', host: '127.0.0.1', port: 11433,
      database: 'beekeeper_test', authType: 'sql', username: 'sa',
      password: 'Beekeeper#2024!', savePassword: true,
      options: { encrypt: true, trustServerCertificate: true }
    })
  })()
`)
await ev('location.reload()')
await delay(1500)
await send('Runtime.enable')

const connect = async () => {
  await waitFor(`!!document.querySelector('.row .row__buttons')`, 'the saved connection')
  await ev(`[...document.querySelectorAll('.row__buttons .btn')].find(b=>b.textContent.includes('Connect')).click()`)
  await waitFor(`!!document.querySelector('.workspace')`, 'workspace', 45000)
  await waitFor(`document.querySelectorAll('.sidebar .item').length > 0`, 'sidebar')
}
const disconnect = () => ev(`document.querySelector('.status__btn--disconnect').click()`)
const closeWindow = () => ev(`document.querySelector('.titlebar__control--close').click()`)
const quit = () => ev(`window.api.runMenuRole('quit').then(() => true)`)
const modal = () =>
  ev(`(() => {
    const m = document.querySelector('.modal')
    return m && {
      title: m.querySelector('.modal__title')?.textContent.trim(),
      text: m.querySelector('.prompt__text')?.textContent.replace(/\\s+/g, ' ').trim(),
      buttons: [...m.querySelectorAll('.modal__foot .btn')].map(b => b.textContent.trim())
    }
  })()`)
const promptFor = (title) =>
  waitFor(`document.querySelector('.modal__title')?.textContent.includes('${title}')`, `the “${title}” prompt`)
const press = (label) =>
  ev(`[...document.querySelectorAll('.modal__foot .btn')].find(b => b.textContent.trim() === '${label}').click()`)
const promptGone = () => waitFor(`!document.querySelector('.modal')`, 'the prompt to go')
const runSql = (sql) =>
  ev(`(async () => {
    const [connection] = await window.api.listConnections()
    const result = await window.api.runQuery({ connectionId: connection.id, sql: ${JSON.stringify(sql)} })
    return result.statements.map((s) => s.error?.message ?? 'ok')
  })()`)

await connect()

// --- 1. nothing unsaved, nothing asked ---------------------------------------
await disconnect()
await waitFor(`!!document.querySelector('.row .row__buttons')`, 'the connection screen')
check(!(await ev(`!!document.querySelector('.modal')`)), 'disconnecting with nothing unsaved asked something')
steps.push({ step: 'disconnected with nothing unsaved' })
await connect()

// --- 2. work in two places: a routine changed, a table with a staged row ----
check(
  (await runSql(`CREATE OR ALTER PROCEDURE dbo.usp_e2e_unsaved
  @status varchar(20)
AS
BEGIN
  SELECT order_id FROM sales.orders WHERE status = @status;
END`)).every((s) => s === 'ok'),
  'could not create the procedure'
)
await ev(`document.querySelector('.sidebar__db-btn[title^="Refresh"]').click()`)
const routineItem = `[...document.querySelectorAll('.sidebar .item__name')].find(e => e.textContent.trim() === 'usp_e2e_unsaved')?.closest('.item')`
await waitFor(`!!${routineItem}`, 'the procedure in the tree')
await ev(`(() => { const item = ${routineItem}; item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); item.click(); return true })()`)
await waitFor(`document.querySelector('.cm-content')?.textContent.includes('usp_e2e_unsaved')`, 'the definition')
await ev(`document.querySelector('.cm-content').focus()`)
await key('End', 'End', 35, 2) // Ctrl+End: the end of the script
await send('Input.insertText', { text: '\n-- not saved yet' })
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('1 change')`, 'the routine changed')

const stageRow = async () => {
  await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.trim() === '+ Row').click()`)
  await waitFor(`[...document.querySelectorAll('.data__toolbar .btn')].some(b => b.textContent.includes('Apply'))`, 'a staged row')
}
await ev(`[...document.querySelectorAll('.sidebar .item__name')].find(e => e.textContent.trim() === 'customers').closest('.item').click()`)
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('rows')`, 'the table')
await stageRow()

// --- 3. disconnecting asks, table first, and Cancel keeps everything --------
await disconnect()
await promptFor('This table has staged edits')
steps.push({ step: 'disconnect: table', ...(await modal()) })
check(steps.at(-1).text.includes('Disconnecting would discard it'), 'the table prompt does not say it is disconnecting')
await shot('01-disconnect-table')
await press('Cancel')
await promptGone()
check(await ev(`!!document.querySelector('.workspace')`), 'Cancel disconnected anyway')
check(await ev(`[...document.querySelectorAll('.data__toolbar .btn')].some(b => b.textContent.includes('Apply'))`), 'Cancel lost the staged row')

// Discarding the table moves on to the routine, which can still keep it all.
await disconnect()
await promptFor('This table has staged edits')
await press('Discard')
await promptFor('This routine has changes')
steps.push({ step: 'disconnect: routine', ...(await modal()) })
check(steps.at(-1).text.includes('Disconnecting would discard it'), 'the routine prompt does not say it is disconnecting')
check(steps.at(-1).buttons.includes('Save and disconnect'), 'the routine prompt does not offer to save and disconnect')
await shot('02-disconnect-routine')
await press('Cancel')
await promptGone()
check(await ev(`!!document.querySelector('.workspace')`), 'Cancel on the routine disconnected anyway')
check((await ev(`document.querySelectorAll('.tab').length`)) >= 2, 'Cancel on the routine closed its tab')

// --- 4. closing the window asks ---------------------------------------------
await stageRow()
await closeWindow()
await promptFor('This table has staged edits')
steps.push({ step: 'close window: table', ...(await modal()) })
check(steps.at(-1).text.includes('Closing the window would discard it'), 'the table prompt does not say the window is closing')
await press('Discard')
await promptFor('This routine has changes')
steps.push({ step: 'close window: routine', ...(await modal()) })
check(steps.at(-1).text.includes('Closing the window would discard it'), 'the routine prompt does not say the window is closing')
await shot('03-close-window')
await press('Cancel')
await promptGone()
await delay(1000)
check(!exited && (await ev('true')), 'the window closed after Cancel')

// --- 5. quitting asks ---------------------------------------------------------
await quit()
await promptFor('This routine has changes')
steps.push({ step: 'quit: routine', ...(await modal()) })
check(steps.at(-1).text.includes('Quitting would discard it'), 'the routine prompt does not say the app is quitting')
check(steps.at(-1).buttons.includes('Save and quit'), 'the routine prompt does not offer to save and quit')
await shot('04-quit')
await press('Cancel')
await promptGone()
await delay(1000)
check(!exited && (await ev('true')), 'the app quit after Cancel')

// --- 6. once everything has been answered, the window does close --------------
await runSql('DROP PROCEDURE IF EXISTS dbo.usp_e2e_unsaved')
await closeWindow()
await promptFor('This routine has changes')
steps.push({ step: 'close window, answered' })
// The answer closes the window, and with the last one the app; nothing will
// reply to this, so it is not waited on.
socket.send(JSON.stringify({
  id: nextId++,
  method: 'Runtime.evaluate',
  params: { expression: `[...document.querySelectorAll('.modal__foot .btn')].find(b => b.textContent.trim() === 'Discard').click()` }
}))
for (let i = 0; i < 50 && !exited; i += 1) await delay(200)
check(exited, 'the window did not close once every question was answered')

console.log('UNSAVED E2E PASS')
console.log(JSON.stringify(steps, null, 2))
process.exit(0)
