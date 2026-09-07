/**
 * Boots the built Electron app on a virtual display and drives it over the
 * DevTools protocol to prove the window opens, the preload bridge is exposed
 * and the UI renders. Writes a screenshot for visual inspection.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9222
const OUT = process.argv[2] ?? `${PROJECT}/.tmp/smoke.png`
mkdirSync(`${PROJECT}/.tmp`, { recursive: true })
const USER_DATA = process.argv[3] ?? `${PROJECT}/.tmp/profile-smoke`

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${USER_DATA}`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(['out', d.toString()]))
child.stderr.on('data', (d) => logs.push(['err', d.toString()]))

let exited = null
child.on('exit', (code, signal) => { exited = { code, signal } })

function fail(message) {
  console.log('SMOKE FAIL:', message)
  console.log('--- process output ---')
  for (const [stream, text] of logs) process.stdout.write(`[${stream}] ${text}`)
  if (exited) console.log('process exited:', JSON.stringify(exited))
  child.kill('SIGKILL')
  process.exit(1)
}

async function findPage() {
  for (let i = 0; i < 60; i += 1) {
    if (exited) fail(`electron exited early: ${JSON.stringify(exited)}`)
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* devtools not listening yet */
    }
    await delay(500)
  }
  fail('no debuggable page appeared within 30s')
}

const page = await findPage()
const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

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
  socket.addEventListener('error', () => reject(new Error('devtools socket failed')))
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
    }, 20000)
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails)}`)
  }
  return result.result.value
}

await send('Runtime.enable')
await send('Page.enable')

// Give the Vue app time to mount and finish its startup IPC round-trips.
for (let i = 0; i < 40; i += 1) {
  const mounted = await evaluate(`!!document.querySelector('.brand__title')`)
  if (mounted) break
  await delay(500)
}

const checks = {}
checks.title = await evaluate('document.title')
checks.heading = await evaluate(
  `document.querySelector('.brand__title')?.textContent?.trim() ?? null`
)
checks.apiExposed = await evaluate('typeof window.api')
checks.apiMethods = await evaluate('Object.keys(window.api ?? {}).length')
checks.theme = await evaluate('document.documentElement.getAttribute("data-theme")')
checks.appInfo = await evaluate('(async () => JSON.stringify(await window.api.getAppInfo()))()')
checks.connections = await evaluate('(async () => JSON.stringify(await window.api.listConnections()))()')
checks.settings = await evaluate('(async () => JSON.stringify(await window.api.getSettings()))()')
checks.emptyState = await evaluate(
  `document.querySelector('.empty-state__title')?.textContent?.trim() ?? null`
)
checks.newButton = await evaluate(
  `[...document.querySelectorAll('button')].some(b => b.textContent.includes('New connection'))`
)
// The error envelope must arrive as a real Error, not a resolved value.
checks.errorPropagation = await evaluate(
  `window.api.listDatabases('does-not-exist').then(() => 'RESOLVED', e => 'THREW: ' + e.message)`
)
// Round-trip a saved connection through the real store.
checks.saveRoundTrip = await evaluate(`
  (async () => {
    const saved = await window.api.saveConnection({
      name: 'Smoke test', host: 'localhost', port: 1433,
      username: 'sa', password: 'secret', savePassword: true
    })
    const list = await window.api.listConnections()
    const found = list.find(c => c.id === saved.id)
    const leaked = JSON.stringify(list).includes('secret')
    await window.api.deleteConnection(saved.id)
    return JSON.stringify({ saved: !!found, hasSavedPassword: found?.hasSavedPassword, leaked })
  })()
`)

const screenshot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT, Buffer.from(screenshot.data, 'base64'))

const rendererErrors = logs
  .map(([, text]) => text)
  .join('')
  .split('\n')
  .filter((line) => /ERROR|Uncaught|Failed to load|Refused to/i.test(line))
  .filter((line) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools listening|Fontconfig|MESA|swiftshader/i.test(line))
  // The error-propagation check above deliberately provokes this one.
  .filter((line) => !line.includes('db:listDatabases failed'))

console.log(JSON.stringify({ checks, rendererErrors, screenshot: OUT }, null, 2))

socket.close()
child.kill('SIGTERM')
await delay(800)
child.kill('SIGKILL')
process.exit(0)
