/**
 * Duplicating a saved connection, in the real UI.
 *
 * Duplicating exists to make editing easier — copy the connection that works,
 * change the one field that differs — so what this suite is really checking is
 * that the copy arrives ready to edit and that the original comes out of it
 * untouched. No database is needed: nothing here connects.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9228
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-connections`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    `--user-data-dir=${PROJECT}/.tmp/profile-connections`
  ],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
const failures = []
function bail(message) {
  console.log('CONNECTIONS E2E FAIL:', message)
  console.log(JSON.stringify(steps, null, 2))
  process.stdout.write(logs.join('').split('\n').slice(-25).join('\n'))
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
    await delay(250)
  }
  bail('timed out waiting for ' + label)
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'))
}
const setInput = (selector, value) => ev(`
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()
`)
/** Records a broken expectation without stopping: one run, every failure. */
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push({ label, expected, actual })
  }
}
/** What is stored, as the list screen sees it. */
const saved = () => ev(`
  (async () => JSON.stringify((await window.api.listConnections()).map((c) => ({
    name: c.name, host: c.host, database: c.database, colour: c.color,
    password: c.hasSavedPassword, sshPassword: c.hasSavedSshPassword
  }))))()
`).then(JSON.parse)
/**
 * The connection row whose name cell reads exactly this.
 *
 * Scoped to the list's body: the connection form calls its field rows `.row`
 * too, and it is open for most of this suite.
 */
const ROWS = `document.querySelectorAll('.table__body .row')`
const row = (name) =>
  `[...${ROWS}].find((r) => r.querySelector('.row__name').textContent.trim() === ${JSON.stringify(name)})`

await send('Runtime.enable'); await send('Page.enable')
await waitFor(`!!document.querySelector('.brand__title')`, 'connection screen')

// Two connections, the first carrying every secret a copy has to bring along.
await ev(`
  (async () => {
    for (const c of await window.api.listConnections()) await window.api.deleteConnection(c.id)
    await window.api.saveConnection({
      name: 'Production reporting', host: 'prod-sql.internal', port: 1433,
      database: 'Reporting', username: 'svc_report', password: 'secret-pw',
      savePassword: true, color: '#d64545',
      ssh: { enabled: true, host: 'bastion.internal', port: 22, username: 'deploy',
             authMode: 'password', password: 'ssh-pw', keepaliveIntervalMs: 30000 }
    })
    await window.api.saveConnection({ name: 'Local dev', host: 'localhost', port: 1433, username: 'sa' })
  })()
`)
await ev('location.reload()')
await delay(1200)
await send('Runtime.enable')
await waitFor(`${ROWS}.length === 2`, 'both rows')
await shot('01-list')

// Duplicate from the list. The copy opens in the form with its name selected,
// because renaming it is the first thing anyone does next.
await ev(`${row('Production reporting')}.querySelector('.row__buttons .btn').click()`)
await waitFor(`!!document.querySelector('.form__tabs')`, 'form on the copy')
const opened = {
  step: 'duplicated from the list',
  kicker: await ev(`document.querySelector('.kicker')?.textContent?.trim()`),
  name: await ev(`document.querySelector('.form input.input').value`),
  nameSelected: await ev(`
    (() => {
      const el = document.querySelector('.form input.input')
      return document.activeElement === el && el.selectionEnd - el.selectionStart === el.value.length
    })()
  `),
  host: await ev(`[...document.querySelectorAll('.form .input')].some((i) => i.value === 'prod-sql.internal')`),
  // The password came across, so the copy is connectable without retyping it.
  passwordKept: await ev(`document.querySelector('input[type=password]')?.placeholder`)
}
steps.push(opened)
check('copy opens in the form', [opened.kicker, opened.name, opened.nameSelected, opened.host], [
  'Copy of Production reporting', 'Production reporting (copy)', true, true
])
await shot('02-form-on-copy')

// Rename it and save. The original must come through completely untouched.
await setInput('.form input.input', 'Staging reporting')
await ev(`document.querySelector('.form button[type=submit]').click()`)
await waitFor(`!document.querySelector('.form__tabs')`, 'form closes')
const afterSave = await saved()
steps.push({ step: 'copy saved', connections: afterSave })
check('the original is untouched', afterSave.find((c) => c.name === 'Production reporting'), {
  name: 'Production reporting', host: 'prod-sql.internal', database: 'Reporting',
  colour: '#d64545', password: true, sshPassword: true
})
check('the copy carries the secrets', afterSave.find((c) => c.name === 'Staging reporting'), {
  name: 'Staging reporting', host: 'prod-sql.internal', database: 'Reporting',
  colour: '#d64545', password: true, sshPassword: true
})
await shot('03-list-after-save')

// The other route: open a connection, change a field, and fork it from inside
// the form. The edits land on the copy and nowhere else.
await ev(`${row('Production reporting')}.querySelectorAll('.row__buttons .btn')[1].click()`)
await waitFor(`!!document.querySelector('.form__tabs')`, 'edit form')
await ev(`
  (() => {
    const el = [...document.querySelectorAll('.form .input')].find((i) => i.value === 'prod-sql.internal')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, 'prod-sql-replica.internal')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()
`)
await ev(`[...document.querySelectorAll('.form__foot .btn')].find((b) => b.textContent.includes('Save as copy')).click()`)
await waitFor(`${ROWS}.length === 4`, 'the second copy')
const afterFork = await saved()
steps.push({
  step: 'saved as copy',
  kicker: await ev(`document.querySelector('.kicker')?.textContent?.trim()`),
  stillOpenOn: await ev(`document.querySelector('.form input.input')?.value`),
  connections: afterFork
})
// An untouched name would have made two rows called the same thing.
check('the fork is named apart from its source', afterFork.find((c) => c.name === 'Production reporting (copy)'), {
  name: 'Production reporting (copy)', host: 'prod-sql-replica.internal', database: 'Reporting',
  colour: '#d64545', password: true, sshPassword: true
})
check('the edit did not reach the original', afterFork.find((c) => c.name === 'Production reporting').host,
  'prod-sql.internal')
await shot('04-save-as-copy')

// Copies of copies number rather than stack: never "Prod (copy) (copy)".
await ev(`document.querySelector('.modal__close').click()`)
await waitFor(`!document.querySelector('.form__tabs')`, 'form closed')
await ev(`${row('Production reporting (copy)')}.querySelector('.row__buttons .btn').click()`)
await waitFor(`!!document.querySelector('.form__tabs')`, 'form on the third copy')
const numbered = await ev(`document.querySelector('.form input.input').value`)
steps.push({ step: 'copy of a copy', name: numbered })
check('copies of copies are numbered', numbered, 'Production reporting (copy 2)')

// Cancel means "stop editing", not "un-make the copy": the duplicate was saved
// the moment it was made, and the toast said so.
await ev(`[...document.querySelectorAll('.form__foot .btn')].find((b) => b.textContent.includes('Cancel')).click()`)
await waitFor(`!document.querySelector('.form__tabs')`, 'form cancelled')
const names = (await saved()).map((c) => c.name).sort()
steps.push({ step: 'after cancel', names })
check('cancelling leaves the copy alone', names, [
  'Local dev',
  'Production reporting',
  'Production reporting (copy 2)',
  'Production reporting (copy)',
  'Staging reporting'
])
await shot('05-final-list')

const rendererErrors = logs.join('').split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif|ssl_client_socket/i.test(l))

console.log(JSON.stringify({ steps, failures, rendererErrors }, null, 2))
socket.close(); child.kill('SIGKILL')
process.exit(failures.length === 0 && rendererErrors.length === 0 ? 0 : 1)
