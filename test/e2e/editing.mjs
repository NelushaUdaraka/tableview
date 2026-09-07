/**
 * Drives the staged-editing flow through the real UI: edit a cell, insert a
 * row, delete a row, apply the change set, and confirm the database changed.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9225
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-editing`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-editing`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('EDIT E2E FAIL:', message)
  console.log(JSON.stringify(steps, null, 2))
  process.stdout.write(logs.join('').split('\n').slice(-30).join('\n'))
  child.kill('SIGKILL')
  process.exit(1)
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
    await delay(300)
  }
  bail('timed out waiting for ' + label)
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'))
}

await send('Runtime.enable'); await send('Page.enable')
await waitFor(`!!document.querySelector('.brand__title') || !!document.querySelector('.workspace')`, 'app')

// Seed a connection and reload so the UI picks it up.
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
await waitFor(`!!document.querySelector('.card')`, 'connection card')
await ev(`[...document.querySelectorAll('.card__buttons .btn')].find(b=>b.textContent.includes('Connect')).click()`)
await waitFor(`!!document.querySelector('.workspace')`, 'workspace', 45000)
await waitFor(`document.querySelectorAll('.sidebar .item').length > 0`, 'sidebar')

// Native confirm() would block the renderer; auto-accept it for the test.
await ev(`window.confirm = () => true; true`)

// Open the table.
await ev(`
  [...document.querySelectorAll('.sidebar .item__name')].find(e => e.textContent.trim() === 'customers').closest('.item').click()
`)
await waitFor(`document.querySelectorAll('.grid__row').length > 0`, 'rows')

const columnIndex = await ev(
  `[...document.querySelectorAll('.grid__th-name')].findIndex(e => e.textContent.trim() === 'display_name')`
)
steps.push({ step: 'opened table', columnIndex, rows: await ev(`document.querySelectorAll('.grid__row').length`) })

// --- 1. edit a cell ---------------------------------------------------------
const before = await ev(
  `document.querySelectorAll('.grid__row')[1].querySelectorAll('.grid__cell')[${columnIndex}].textContent.trim()`
)
await ev(`
  (() => {
    const cell = document.querySelectorAll('.grid__row')[1].querySelectorAll('.grid__cell')[${columnIndex}]
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()
`)
await waitFor(`!!document.querySelector('.grid__editor')`, 'cell editor')
await ev(`document.querySelector('.grid__editor').select()`)
await send('Input.insertText', { text: 'Edited By Test' })
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await delay(500)

steps.push({
  step: 'cell edited',
  before,
  after: await ev(
    `document.querySelectorAll('.grid__row')[1].querySelectorAll('.grid__cell')[${columnIndex}].textContent.trim()`
  ),
  markedEdited: await ev(`!!document.querySelector('.grid__cell--edited')`),
  applyLabel: await ev(
    `[...document.querySelectorAll('.data__toolbar .btn')].map(b=>b.textContent.trim()).find(t=>t.startsWith('Apply')) ?? null`
  ),
  tabBadge: await ev(`document.querySelector('.table-view__badge')?.textContent?.trim() ?? null`)
})
await shot('01-cell-edited')

// --- 2. stage an inserted row ----------------------------------------------
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b=>b.textContent.includes('+ Row')).click()`)
await waitFor(`!!document.querySelector('.grid__row--inserted')`, 'inserted row')
const emailIndex = await ev(
  `[...document.querySelectorAll('.grid__th-name')].findIndex(e => e.textContent.trim() === 'email')`
)
const insertedRowIndex = await ev(`document.querySelectorAll('.grid__row').length - 1`)
await ev(`
  (() => {
    const rows = document.querySelectorAll('.grid__row')
    const cell = rows[${insertedRowIndex}].querySelectorAll('.grid__cell')[${emailIndex}]
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()
`)
await waitFor(`!!document.querySelector('.grid__editor')`, 'editor for new row')
await send('Input.insertText', { text: 'inserted-by-test@example.com' })
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await delay(400)
steps.push({
  step: 'row staged',
  insertedRows: await ev(`document.querySelectorAll('.grid__row--inserted').length`),
  applyLabel: await ev(
    `[...document.querySelectorAll('.data__toolbar .btn')].map(b=>b.textContent.trim()).find(t=>t.startsWith('Apply')) ?? null`
  )
})
await shot('02-row-staged')

// --- 3. apply -------------------------------------------------------------
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b=>b.textContent.includes('Apply')).click()`)
await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Changes applied'))`, 'apply toast', 30000)
await delay(1200)
steps.push({
  step: 'applied',
  toast: await ev(`[...document.querySelectorAll('.toast')].map(t=>t.textContent.trim())`),
  rowCount: await ev(`document.querySelectorAll('.grid__row').length`),
  pendingGone: await ev(`![...document.querySelectorAll('.data__toolbar .btn')].some(b=>b.textContent.includes('Apply'))`),
  // Read straight from the database to confirm it really persisted.
  verified: await ev(`
    (async () => {
      const cons = await window.api.listConnections()
      const r = await window.api.runQuery({
        connectionId: cons[0].id,
        sql: "SELECT display_name FROM dbo.customers WHERE customer_id = 2; SELECT COUNT(*) FROM dbo.customers WHERE email = 'inserted-by-test@example.com';"
      })
      const sets = r.statements[0].resultSets
      return JSON.stringify({ renamed: sets[0].rows[0][0], insertedCount: sets[1].rows[0][0] })
    })()
  `)
})
await shot('03-applied')

// --- 4. delete the inserted row through the context menu -------------------
await ev(`
  (() => {
    const emailIdx = ${emailIndex}
    const rows = [...document.querySelectorAll('.grid__row')]
    const target = rows.find(r => r.querySelectorAll('.grid__cell')[emailIdx].textContent.includes('inserted-by-test'))
    const cell = target.querySelectorAll('.grid__cell')[emailIdx]
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }))
    return true
  })()
`)
await waitFor(`!!document.querySelector('.menu')`, 'context menu')
await ev(`[...document.querySelectorAll('.menu__item')].find(i=>i.textContent.includes('Delete row')).click()`)
await waitFor(`!!document.querySelector('.grid__row--deleted')`, 'row marked deleted')
await shot('04-row-marked-deleted')

await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b=>b.textContent.includes('Apply')).click()`)
await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Changes applied'))`, 'delete toast', 30000)
await delay(1000)
steps.push({
  step: 'deleted',
  remaining: await ev(`
    (async () => {
      const cons = await window.api.listConnections()
      const r = await window.api.runQuery({
        connectionId: cons[0].id,
        sql: "SELECT COUNT(*) FROM dbo.customers WHERE email = 'inserted-by-test@example.com'"
      })
      return r.statements[0].resultSets[0].rows[0][0]
    })()
  `)
})
await shot('05-after-delete')

// --- 5. filters through the UI ---------------------------------------------
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b=>b.textContent.includes('Filter')).click()`)
await waitFor(`!!document.querySelector('.filters')`, 'filter panel')
await ev(`[...document.querySelectorAll('.filters .btn')].find(b=>b.textContent.includes('Add filter')).click()`)
await waitFor(`!!document.querySelector('.filters__row')`, 'filter row')
// One control at a time, letting Vue flush between them — a real user cannot
// change three inputs inside a single task, and doing so reads stale props.
await ev(`
  (() => {
    const el = document.querySelector('.filters__column')
    el.value = 'is_active'
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()
`)
await delay(400)
await ev(`
  (() => {
    const el = document.querySelector('.filters__op')
    el.value = '='
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()
`)
await delay(400)
await ev(`
  (() => {
    const input = document.querySelector('.filters__value')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '0')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()
`)
await delay(400)
steps.push({
  step: 'filter configured',
  column: await ev(`document.querySelector('.filters__column').value`),
  operator: await ev(`document.querySelector('.filters__op').value`),
  value: await ev(`document.querySelector('.filters__value').value`)
})
await ev(`[...document.querySelectorAll('.filters .btn')].find(b=>b.textContent.trim()==='Apply').click()`)
await delay(1500)
steps.push({
  step: 'filtered',
  rowCount: await ev(`document.querySelectorAll('.grid__row').length`),
  pageInfo: await ev(`document.querySelector('.data__page')?.textContent?.trim()`),
  sql: await ev(`document.querySelector('.data__sql')?.textContent?.trim()`)
})
await shot('06-filtered')

// Restore the seeded value so the run is repeatable.
await ev(`
  (async () => {
    const cons = await window.api.listConnections()
    await window.api.runQuery({
      connectionId: cons[0].id,
      sql: "UPDATE dbo.customers SET display_name = N'Alan Turing' WHERE customer_id = 2"
    })
  })()
`)

const rendererErrors = logs.join('').split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif/i.test(l))

console.log(JSON.stringify({ steps, rendererErrors }, null, 2))
socket.close(); child.kill('SIGKILL'); process.exit(0)
