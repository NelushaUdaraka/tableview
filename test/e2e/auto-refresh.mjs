/**
 * Drives a table's auto refresh through the real app: off when a table opens,
 * rows written by someone else turning up on their own once it is on, held
 * while edits are staged, kept by the tab across a trip to another tab, and
 * stopped — with a word about it — by a read that fails.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9230
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-auto-refresh`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-auto-refresh`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('AUTO REFRESH E2E FAIL:', message)
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
await waitFor(`!!document.querySelector('.row .row__buttons')`, 'the saved connection')
await ev(`[...document.querySelectorAll('.row__buttons .btn')].find(b=>b.textContent.includes('Connect')).click()`)
await waitFor(`!!document.querySelector('.workspace')`, 'workspace', 45000)
await waitFor(`document.querySelectorAll('.sidebar .item').length > 0`, 'sidebar')

const runSql = (sql) =>
  ev(`(async () => {
    const [connection] = await window.api.listConnections()
    const result = await window.api.runQuery({ connectionId: connection.id, sql: ${JSON.stringify(sql)} })
    return result.statements.map((s) => s.error?.message ?? 'ok')
  })()`)

check(
  (
    await runSql(`DROP TABLE IF EXISTS dbo.e2e_ticks;
GO
CREATE TABLE dbo.e2e_ticks (id int IDENTITY(1,1) PRIMARY KEY, note nvarchar(50) NULL);
GO
INSERT INTO dbo.e2e_ticks (note) VALUES (N'one'), (N'two'), (N'three');`)
  ).every((s) => s === 'ok'),
  'could not create the table'
)
const insert = (note) => runSql(`INSERT INTO dbo.e2e_ticks (note) VALUES (N'${note}')`)
const rowsLabel = () => ev(`document.querySelector('.data__rows')?.textContent.trim()`)
const auto = () =>
  ev(`(() => {
    const box = document.querySelector('.data__auto')
    return box && {
      shows: box.querySelector('.data__auto-value').textContent.trim(),
      value: box.querySelector('select').value,
      armed: box.classList.contains('btn--armed'),
      paused: box.classList.contains('data__auto--paused'),
      title: box.title
    }
  })()`)
const choose = (ms) =>
  ev(`(() => {
    const select = document.querySelector('.data__auto-select')
    select.value = '${ms}'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
const openTable = async (name) => {
  await ev(`[...document.querySelectorAll('.sidebar .item__name')].find(e => e.textContent.trim() === '${name}').closest('.item').click()`)
  await waitFor(`document.querySelector('.tab--active .tab__title')?.textContent.trim() === '${name}'`, `the ${name} tab`)
}

// --- 1. a table opens with auto refresh off ----------------------------------
await ev(`document.querySelector('.sidebar__db-btn[title^="Refresh"]').click()`)
await waitFor(`!!document.querySelector('.sidebar .item__name') && [...document.querySelectorAll('.sidebar .item__name')].some(e => e.textContent.trim() === 'e2e_ticks')`, 'the table in the tree')
await openTable('e2e_ticks')
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('3 rows')`, 'three rows')
steps.push({ step: 'opened', auto: await auto() })
check(steps.at(-1).auto.value === '0' && !steps.at(-1).auto.armed, 'a table opened with auto refresh on')
check(
  JSON.stringify(await ev(`[...document.querySelectorAll('.data__auto-select option')].map(o => o.textContent.trim())`)) ===
    JSON.stringify(['Off', 'Every 5 seconds', 'Every 10 seconds', 'Every 30 seconds', 'Every minute', 'Every 5 minutes', 'Every 15 minutes']),
  'the intervals on offer are not the predefined ones'
)

// --- 2. on: rows written elsewhere arrive without a click ---------------------
await choose(5000)
await waitFor(`document.querySelector('.data__auto')?.classList.contains('btn--armed')`, 'the control armed')
await insert('four')
const started = Date.now()
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('4 rows')`, 'the new row, unprompted', 9000)
steps.push({ step: 'refreshed by itself', afterMs: Date.now() - started, auto: await auto() })
check(
  await ev(`[...document.querySelectorAll('.grid__row')].some(row => row.textContent.includes('four'))`),
  'the new row is not in the grid'
)
check(steps.at(-1).auto.shows === '5s', 'the control does not say how often')
check(!(await ev(`!!document.querySelector('.data__refreshing')`)), 'the timer’s reads announce themselves as "Checking for changes"')
await shot('01-auto-on')

// --- 3. held while edits are staged --------------------------------------------
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.trim() === 'Add row').click()`)
await waitFor(`document.querySelector('.data__auto')?.classList.contains('data__auto--paused')`, 'the control paused')
await insert('five')
await delay(7000)
steps.push({ step: 'held for staged edits', rows: await rowsLabel(), auto: await auto() })
check(steps.at(-1).rows === '4 rows', 'auto refresh read the table under staged edits')
check(steps.at(-1).auto.title.includes('Paused while edits are staged'), 'the control does not say why it is paused')
await shot('02-paused')

await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.trim() === 'Discard').click()`)
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('5 rows')`, 'the row written while it was held', 9000)
check(!(await auto()).paused, 'still paused after the edits went')

// --- 4. the tab keeps it across a trip to another tab ---------------------------
await openTable('customers')
check((await auto()).value === '0', 'auto refresh leaked into another table')
await openTable('e2e_ticks')
await waitFor(`document.querySelector('.data__auto-select')?.value === '5000'`, 'the interval kept by the tab')
await insert('six')
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('6 rows')`, 'refreshing again after coming back', 9000)

// --- 5. off means off -------------------------------------------------------------
await choose(0)
await insert('seven')
await delay(7000)
steps.push({ step: 'off', rows: await rowsLabel(), auto: await auto() })
check(steps.at(-1).rows === '6 rows', 'it kept refreshing after being turned off')

// --- 6. a read that fails turns it off, and says so ----------------------------------
await choose(5000)
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('7 rows')`, 'the read on turning it back on', 5000)
await runSql('DROP TABLE dbo.e2e_ticks')
await waitFor(`document.querySelector('.data__auto-select')?.value === '0'`, 'auto refresh stopping itself', 12000)
const toast = await ev(`[...document.querySelectorAll('.toast__message')].map(t => t.textContent.trim())`)
steps.push({ step: 'failure', toast, auto: await auto() })
check(toast.some((text) => text.startsWith('Auto refresh stopped')), 'no word about auto refresh stopping')
await shot('03-stopped')

console.log('AUTO REFRESH E2E PASS')
console.log(JSON.stringify(steps, null, 2))
child.kill('SIGKILL')
process.exit(0)
