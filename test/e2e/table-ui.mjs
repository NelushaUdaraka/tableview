/**
 * Drives the table browser's UI through the real app: the row panel beside the
 * grid, editing a field in it, following a foreign key into the referenced
 * table, and the custom title bar's menus and window buttons.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9226
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-table-ui`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-table-ui`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('TABLE UI E2E FAIL:', message)
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
await waitFor(`!!document.querySelector('.titlebar')`, 'title bar')

// --- 1. the title bar replaces the window frame -----------------------------
steps.push({
  step: 'title bar',
  menus: await ev(`[...document.querySelectorAll('.titlebar__menu')].map(b => b.textContent.trim())`),
  windowButtons: await ev(`document.querySelectorAll('.titlebar__control').length`),
  title: await ev(`document.querySelector('.titlebar__title').textContent.trim()`)
})

await ev(`[...document.querySelectorAll('.titlebar__menu')].find(b => b.textContent.trim() === 'View').click()`)
await waitFor(`!!document.querySelector('.titlebar__dropdown')`, 'the View menu')
steps.push({
  step: 'view menu',
  items: await ev(
    `[...document.querySelectorAll('.titlebar__dropdown .titlebar__item')].map(i => i.textContent.trim().replace(/\\s+/g,' '))`
  )
})
await shot('01-title-bar-menu')
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)

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
await waitFor(`!!document.querySelector('.row')`, 'connection row')
await ev(`[...document.querySelectorAll('.row__buttons .btn')].find(b=>b.textContent.includes('Connect')).click()`)
await waitFor(`!!document.querySelector('.workspace')`, 'workspace', 45000)
await waitFor(`document.querySelectorAll('.sidebar .item').length > 0`, 'sidebar')

// The suite edits one row; put it back to its seeded value first so a rerun
// (or a run after a failed one) stages a real change.
await ev(`
  (async () => {
    const cons = await window.api.listConnections()
    await window.api.runQuery({
      connectionId: cons[0].id,
      sql: "UPDATE sales.orders SET status = 'cancelled' WHERE customer_id = 2"
    })
  })()
`)

// --- 2. the row panel shows the selected row --------------------------------
await ev(`
  [...document.querySelectorAll('.sidebar .item__name')].find(e => e.textContent.trim() === 'orders').closest('.item').click()
`)
await waitFor(`document.querySelectorAll('.grid__row').length > 0`, 'order rows')

const statusIndex = await ev(
  `[...document.querySelectorAll('.grid__th-name')].findIndex(e => e.textContent.trim() === 'status')`
)
const customerIndex = await ev(
  `[...document.querySelectorAll('.grid__th-name')].findIndex(e => e.textContent.trim() === 'customer_id')`
)

await ev(`
  (() => {
    const cell = document.querySelectorAll('.grid__row')[2].querySelectorAll('.grid__cell')[${statusIndex}]
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return true
  })()
`)
await waitFor(`document.querySelectorAll('.rowpanel__field').length > 0`, 'row panel fields')
steps.push({
  step: 'row panel',
  label: await ev(`document.querySelector('.rowpanel__title').textContent.trim()`),
  fields: await ev(`[...document.querySelectorAll('.rowpanel__name')].map(e => e.textContent.trim())`),
  values: await ev(`[...document.querySelectorAll('.rowpanel__value')].map(e => e.value ?? e.textContent.trim())`),
  selectedField: await ev(
    `document.querySelector('.rowpanel__field--selected .rowpanel__name')?.textContent.trim() ?? null`
  ),
  foreignKeyArrows: await ev(`document.querySelectorAll('.rowpanel__fk').length`)
})
await shot('02-row-panel')

// --- 3. editing a field in the panel stages the same edit as the grid --------
await ev(`
  (() => {
    const names = [...document.querySelectorAll('.rowpanel__name')].map(e => e.textContent.trim())
    const index = names.indexOf('status')
    const box = document.querySelectorAll('.rowpanel__value')[index]
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, 'refunded')
    box.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()
`)
await delay(400)
steps.push({
  step: 'edited through the panel',
  gridCell: await ev(
    `document.querySelectorAll('.grid__row')[2].querySelectorAll('.grid__cell')[${statusIndex}].textContent.trim()`
  ),
  markedEdited: await ev(`!!document.querySelector('.grid__cell--edited')`),
  panelMarked: await ev(`!!document.querySelector('.rowpanel__field--edited')`),
  applyLabel: await ev(
    `[...document.querySelectorAll('.data__toolbar .btn')].map(b=>b.textContent.trim()).find(t=>t.startsWith('Apply')) ?? null`
  )
})
await shot('03-panel-edit')

await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b=>b.textContent.includes('Apply')).click()`)
// The review before Apply, answered.
await waitFor(`!!document.querySelector('.statement__sql')`, 'the review before Apply')
await ev(`[...document.querySelectorAll('.modal__foot .btn')].find(b => b.textContent.trim() === 'Apply').click()`)
await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Changes applied'))`, 'apply toast', 30000)
await delay(1000)
steps.push({
  step: 'applied',
  stored: await ev(`
    (async () => {
      const cons = await window.api.listConnections()
      const r = await window.api.runQuery({
        connectionId: cons[0].id,
        sql: "SELECT status FROM sales.orders WHERE customer_id = 2"
      })
      return r.statements[0].resultSets[0].rows[0][0]
    })()
  `)
})

// --- 4. following a foreign key --------------------------------------------
const arrows = await ev(`document.querySelectorAll('.grid__fk').length`)
await ev(`
  (() => {
    const cell = document.querySelectorAll('.grid__row')[2].querySelectorAll('.grid__cell')[${customerIndex}]
    cell.querySelector('.grid__fk').click()
    return true
  })()
`)
await waitFor(
  `document.querySelector('.tab--active .tab__title')?.textContent?.trim() === 'customers'`,
  'the customers tab'
)
await waitFor(`document.querySelectorAll('.grid__row').length > 0`, 'customer rows')
steps.push({
  step: 'followed the foreign key',
  arrowsInGrid: arrows,
  tab: await ev(`document.querySelector('.tab--active .tab__title').textContent.trim()`),
  filter: await ev(`
    (() => {
      const row = document.querySelector('.filters__row')
      if (!row) return null
      return [row.querySelector('.filters__column').value,
              row.querySelector('.filters__op').value,
              row.querySelector('.filters__value').value].join(' ')
    })()
  `),
  rowCount: await ev(`document.querySelectorAll('.grid__row').length`),
  firstRow: await ev(
    `[...document.querySelectorAll('.grid__row')[0].querySelectorAll('.grid__cell')].map(c => c.textContent.trim())`
  ),
  pageInfo: await ev(`document.querySelector('.data__page').textContent.trim()`),
  // The related row should be the one waiting in the panel.
  panelLabel: await ev(`document.querySelector('.rowpanel__title').textContent.trim()`),
  panelEmail: await ev(`
    (() => {
      const names = [...document.querySelectorAll('.rowpanel__name')].map(e => e.textContent.trim())
      const box = document.querySelectorAll('.rowpanel__value')[names.indexOf('email')]
      return box?.value ?? box?.textContent.trim() ?? null
    })()
  `)
})
await shot('04-followed-foreign-key')

// --- 5. the expanding cell editor ------------------------------------------
const notesIndex = await ev(
  `[...document.querySelectorAll('.grid__th-name')].findIndex(e => e.textContent.trim() === 'notes')`
)
await ev(`
  (() => {
    const cell = document.querySelectorAll('.grid__row')[0].querySelectorAll('.grid__cell')[${notesIndex}]
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()
`)
await waitFor(`!!document.querySelector('.grid__editor')`, 'the cell editor')
await ev(`document.querySelector('.grid__editor').select()`)
await send('Input.insertText', { text: 'line one\nline two\nline three' })
await delay(300)
steps.push({
  step: 'cell editor',
  tagName: await ev(`document.querySelector('.grid__editor').tagName`),
  grewForTheText: await ev(`document.querySelector('.grid__editor').getBoundingClientRect().height > 30`),
  wideEnoughToRead: await ev(`document.querySelector('.grid__editor').getBoundingClientRect().width >= 240`)
})
await shot('05-cell-editor')
await ev(`document.querySelector('.grid__editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)

// --- 6. the row panel can be hidden ----------------------------------------
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b=>b.textContent.trim()==='Add row').click()`)
await delay(400)
steps.push({
  step: 'row panel toggled off',
  visible: await ev(`!!document.querySelector('.rowpanel')?.offsetParent`)
})
await shot('06-row-panel-hidden')
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b=>b.textContent.trim()==='Add row').click()`)

// Leave the seeded data as it was found.
await ev(`
  (async () => {
    const cons = await window.api.listConnections()
    await window.api.runQuery({
      connectionId: cons[0].id,
      sql: "UPDATE sales.orders SET status = 'cancelled' WHERE customer_id = 2"
    })
  })()
`)

const rendererErrors = logs.join('').split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif/i.test(l))

console.log(JSON.stringify({ steps, rendererErrors }, null, 2))
socket.close(); child.kill('SIGKILL'); process.exit(0)
