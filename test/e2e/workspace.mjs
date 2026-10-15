/**
 * End-to-end: launches the real app, connects it to the SQL Server container,
 * and drives the UI through the DevTools protocol — clicking the sidebar,
 * typing into the editor and reading the rendered grid.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9223
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-workspace`
const USER_DATA = `${PROJECT}/.tmp/profile-workspace`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${USER_DATA}`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
let socket
let nextId = 1
const pending = new Map()

function bail(message) {
  console.log('E2E FAIL:', message)
  console.log('--- steps so far ---')
  console.log(JSON.stringify(steps, null, 2))
  console.log('--- process output (tail) ---')
  process.stdout.write(logs.join('').split('\n').slice(-40).join('\n'))
  child.kill('SIGKILL')
  process.exit(1)
}

async function connectDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await delay(500)
  }
  bail('devtools never became available')
}

const url = await connectDevtools()
socket = new WebSocket(url)
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', () => reject(new Error('socket error')))
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`${method} timed out`))
      }
    }, 30000)
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (result.exceptionDetails) {
    bail(`evaluate failed: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`)
  }
  return result.result.value
}

/** Polls an expression until it is truthy. */
async function waitFor(expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(`(() => { try { return ${expression} } catch { return null } })()`)
    if (value) return value
    await delay(300)
  }
  bail(`timed out waiting for ${label}`)
}

async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  const file = `${SHOTS}/${name}.png`
  writeFileSync(file, Buffer.from(result.data, 'base64'))
  return file
}

function record(step, detail) {
  steps.push({ step, ...detail })
}

await send('Runtime.enable')
await send('Page.enable')
await send('Input.enable').catch(() => undefined)

await waitFor(`!!document.querySelector('.brand__title')`, 'connection screen')

// --- 1. save a connection through the real store, then reload the UI --------
const savedId = await evaluate(`
  (async () => {
    for (const c of await window.api.listConnections()) await window.api.deleteConnection(c.id)
    const saved = await window.api.saveConnection({
      name: 'Docker SQL Server',
      host: '127.0.0.1',
      port: 11433,
      database: 'beekeeper_test',
      authType: 'sql',
      username: 'sa',
      password: 'Beekeeper#2024!',
      savePassword: true,
      options: { encrypt: true, trustServerCertificate: true }
    })
    return saved.id
  })()
`)
record('save connection', { savedId })

await evaluate('location.reload()')
await delay(1500)
await send('Runtime.enable')
await waitFor(`!!document.querySelector('.row')`, 'saved connection row')
record('connection listed', {
  name: await evaluate(`document.querySelector('.row__name').textContent.trim()`),
  subtitle: await evaluate(`document.querySelector('.row__sub').textContent.trim()`)
})
const shotConnections = await shot('01-connections')

// --- 2. click Connect ------------------------------------------------------
await evaluate(`
  [...document.querySelectorAll('.row__buttons .btn')]
    .find(b => b.textContent.includes('Connect')).click()
`)
await waitFor(`!!document.querySelector('.workspace')`, 'workspace after connecting', 45000)
record('connected', {
  status: await evaluate(`document.querySelector('.status__name')?.textContent?.trim()`),
  statusText: await evaluate(
    `[...document.querySelectorAll('.status span')].map(s => s.textContent.trim()).filter(Boolean).join(' | ')`
  )
})

// --- 3. sidebar shows the schema -------------------------------------------
await waitFor(`document.querySelectorAll('.sidebar .item').length > 0`, 'sidebar objects')
record('sidebar', {
  schemas: await evaluate(
    `[...document.querySelectorAll('.group__head')].map(e => e.textContent.trim().replace(/\\s+/g,' '))`
  ),
  objectCount: await evaluate(`document.querySelectorAll('.sidebar .item').length`),
  objects: await evaluate(
    `[...document.querySelectorAll('.sidebar .item__name')].map(e => e.textContent.trim())`
  )
})
const shotWorkspace = await shot('02-workspace')

// --- 4. open a table and read the grid -------------------------------------
await evaluate(`
  [...document.querySelectorAll('.sidebar .item')]
    .find(e => e.textContent.includes('customers') && !e.textContent.includes('summary')).click()
`)
await waitFor(`document.querySelectorAll('.grid__row').length > 0`, 'table rows', 30000)
record('table data', {
  tab: await evaluate(`document.querySelector('.tab--active .tab__title')?.textContent?.trim()`),
  headers: await evaluate(
    `[...document.querySelectorAll('.grid__th-name')].map(e => e.textContent.trim())`
  ),
  rowCount: await evaluate(`document.querySelectorAll('.grid__row').length`),
  firstRow: await evaluate(
    `[...document.querySelectorAll('.grid__row')[0].querySelectorAll('.grid__cell')].map(c => c.textContent.trim())`
  ),
  pageInfo: await evaluate(`document.querySelector('.data__page')?.textContent?.trim()`),
  nullRendered: await evaluate(`!!document.querySelector('.grid__null')`)
})
const shotTable = await shot('03-table-data')

// --- 5. structure tab -------------------------------------------------------
await evaluate(`
  [...document.querySelectorAll('.data__toolbar .seg__opt')].find(b => b.textContent.trim() === 'Structure').click()
`)
await waitFor(`document.querySelectorAll('.panel').length > 2`, 'structure panels', 30000)
record('structure', {
  panels: await evaluate(
    `[...document.querySelectorAll('.panel__title')].map(e => e.textContent.trim().replace(/\\s+/g,' '))`
  ),
  columnRows: await evaluate(`document.querySelectorAll('.panel table tbody tr').length`),
  ddlPresent: await evaluate(
    `[...document.querySelectorAll('.code')].some(e => e.textContent.includes('CREATE TABLE'))`
  )
})
const shotStructure = await shot('04-structure')

// --- 6. run a query in the editor ------------------------------------------
await evaluate(`
  [...document.querySelectorAll('.tab')].find(t => t.textContent.includes('Query')).click()
`)
await waitFor(`!!document.querySelector('.cm-content')`, 'editor')
await evaluate(`document.querySelector('.cm-content').focus()`)
await send('Input.insertText', {
  text: "SELECT c.customer_id, c.email, COUNT(o.order_id) AS orders\nFROM dbo.customers c\nLEFT JOIN sales.orders o ON o.customer_id = c.customer_id\nGROUP BY c.customer_id, c.email\nORDER BY orders DESC;"
})
await delay(400)
record('editor', {
  text: await evaluate(`document.querySelector('.cm-content').textContent.slice(0, 60)`)
})

await evaluate(
  `[...document.querySelectorAll('.query__toolbar .btn')].find(b => b.textContent.includes('Run')).click()`
)
await waitFor(`document.querySelectorAll('.results__body .grid__row').length > 0`, 'query results', 30000)
record('query results', {
  headers: await evaluate(
    `[...document.querySelectorAll('.results__body .grid__th-name')].map(e => e.textContent.trim())`
  ),
  rowCount: await evaluate(`document.querySelectorAll('.results__body .grid__row').length`),
  firstRow: await evaluate(
    `[...document.querySelectorAll('.results__body .grid__row')[0].querySelectorAll('.grid__cell')].map(c => c.textContent.trim())`
  ),
  meta: await evaluate(
    `[...document.querySelectorAll('.results__meta span')].map(s => s.textContent.trim()).filter(Boolean)`
  )
})
const shotQuery = await shot('05-query')

// --- 7. an error is surfaced, not swallowed --------------------------------
await evaluate(`document.querySelector('.cm-content').focus()`)
await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
await send('Input.insertText', { text: 'SELECT * FROM dbo.no_such_table;' })
await delay(300)
await evaluate(
  `[...document.querySelectorAll('.query__toolbar .btn')].find(b => b.textContent.includes('Run')).click()`
)
await waitFor(`!!document.querySelector('.message--error')`, 'error message', 30000)
record('error surfaced', {
  title: await evaluate(`document.querySelector('.message__title')?.textContent?.trim().replace(/\\s+/g,' ')`),
  text: await evaluate(`document.querySelector('.message--error .message__text')?.textContent?.trim()`)
})
const shotError = await shot('06-error')

// --- 8. light theme, driven the way a user would ----------------------------
// Disconnect first: the theme toggle lives on the connection screen, and going
// through the real control also exercises the settings store round-trip.
await evaluate(
  `[...document.querySelectorAll('.status__btn')].at(-1).click()`
)
await waitFor(`!!document.querySelector('.screen__actions')`, 'connection screen after disconnect')
await evaluate(
  `document.querySelector('.screen__actions [aria-label="Toggle theme"]').click()`
)
await waitFor(`document.documentElement.getAttribute('data-theme') === 'light'`, 'light theme')
await delay(500)
record('theme toggle', {
  attribute: await evaluate(`document.documentElement.getAttribute('data-theme')`),
  persisted: await evaluate(`(async () => (await window.api.getSettings()).theme)()`)
})
const shotLight = await shot('07-light-theme')

// Reconnect and confirm the editor follows the theme too.
await evaluate(`
  [...document.querySelectorAll('.row__buttons .btn')].find(b => b.textContent.includes('Connect')).click()
`)
await waitFor(`!!document.querySelector('.cm-editor')`, 'editor after reconnect', 45000)
await delay(800)
record('editor theme', {
  editorBackground: await evaluate(
    `getComputedStyle(document.querySelector('.cm-editor')).backgroundColor`
  ),
  bodyBackground: await evaluate(`getComputedStyle(document.body).backgroundColor`)
})
const shotLightWorkspace = await shot('08-light-workspace')

const rendererErrors = logs
  .join('')
  .split('\n')
  .filter((line) => /ERROR|Uncaught|Failed to load|Refused to/i.test(line))
  .filter((line) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools listening|Fontconfig|MESA|swiftshader|CertVerif/i.test(line))

console.log(JSON.stringify({ steps, rendererErrors, screenshots: [shotConnections, shotWorkspace, shotTable, shotStructure, shotQuery, shotError, shotLight, shotLightWorkspace] }, null, 2))

socket.close()
child.kill('SIGTERM')
await delay(800)
child.kill('SIGKILL')
process.exit(0)
