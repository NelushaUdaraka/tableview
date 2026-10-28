/**
 * A server whose certificate this computer cannot check, in the real UI.
 *
 * The test server's certificate is one it made for itself, as most private
 * servers' are, so a connection that checks certificates — every new one — is
 * turned down by it. The window should offer to trust it and try again, from
 * the list's Connect (saving the setting with the connection) and from the
 * form's Test (ticking the box, saved only with the form).
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9243
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-certificate`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-certificate`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
const failures = []
function bail(message) {
  console.log('CERTIFICATE E2E FAIL:', message)
  console.log(JSON.stringify(steps, null, 2))
  process.stdout.write(logs.join('').split('\n').slice(-25).join('\n'))
  child.kill('SIGKILL')
  process.exit(1)
}
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  steps.push({ step: label, ok, actual })
  if (!ok) failures.push({ label, actual, expected })
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

const NAME = 'Self-signed server'
const TITLE = 'Trust the certificate of 127.0.0.1:11433?'
const row = `[...document.querySelectorAll('.table__body .row')].find((r) => r.querySelector('.row__name').textContent.trim() === ${JSON.stringify(NAME)})`
/** The question over the window, if one is up: its title, buttons and what has the focus. */
const question = () =>
  ev(`(() => {
    const m = [...document.querySelectorAll('.modal')].find((x) => x.querySelector('.confirm__message'))
    return m && {
      title: m.querySelector('.modal__title')?.textContent.trim(),
      buttons: [...m.querySelectorAll('.modal__foot .btn')].map((b) => b.textContent.trim()),
      focused: document.activeElement?.textContent.trim() ?? null
    }
  })()`)
const answer = (label) =>
  ev(`[...[...document.querySelectorAll('.modal')].find((x) => x.querySelector('.confirm__message')).querySelectorAll('.modal__foot .btn')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
const savedTrust = () =>
  ev(`window.api.listConnections().then((list) => list.find((c) => c.name === ${JSON.stringify(NAME)})?.options.trustServerCertificate)`)

await send('Runtime.enable')
await waitFor(`!!document.querySelector('.brand__title') || !!document.querySelector('.workspace')`, 'app')

// A connection that checks certificates, as every new one does.
await ev(`
  (async () => {
    for (const c of await window.api.listConnections()) await window.api.deleteConnection(c.id)
    await window.api.saveConnection({
      name: ${JSON.stringify(NAME)}, host: '127.0.0.1', port: 11433,
      database: 'master', authType: 'sql', username: 'sa',
      password: 'Beekeeper#2024!', savePassword: true,
      options: { encrypt: true, trustServerCertificate: false }
    })
  })()
`)
await ev('location.reload()')
await delay(1500)
await send('Runtime.enable')
await waitFor(`!!(${row})`, 'the connection row')

// --- 1. Test in the form: the box is ticked, nothing saved until Save ------
await ev(`${row}.querySelector('.row__menu').click()`)
await waitFor(`!!document.querySelector('.menu')`, 'the ⋮ menu')
await ev(`[...document.querySelectorAll('.menu .menu__item')].find((b) => b.textContent.trim().startsWith('Edit')).click()`)
await waitFor(`!!document.querySelector('.form__tabs')`, 'the edit form')
const trustBox = `[...document.querySelectorAll('.form__section .checkbox')].find((l) => l.textContent.includes('Trust server certificate')).querySelector('input')`
check('the form starts with the box unticked', await ev(`${trustBox}.checked`), false)

await ev(`[...document.querySelectorAll('.form__foot .btn')].find((b) => b.textContent.includes('Test connection')).click()`)
await waitFor(`[...document.querySelectorAll('.modal__title')].some((t) => t.textContent.trim() === ${JSON.stringify(TITLE)})`, 'the question after Test', 45000)
const asked = await question()
check('Test asks about the certificate', asked, { title: TITLE, buttons: ['Cancel', 'Trust and retry'], focused: 'Cancel' })
await shot('asked-after-test')
await answer('Trust and retry')
await waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Connection succeeded'))`, 'the test to succeed', 45000)
check('the form has the box ticked', await ev(`${trustBox}.checked`), true)
check('nothing is saved from a test', await savedTrust(), false)
await ev(`[...document.querySelectorAll('.form__foot button')].find((b) => b.textContent.trim() === 'Cancel').click()`)
await waitFor(`!document.querySelector('.form__tabs')`, 'the form to close')

// --- 2. Connect, and say no: nothing changes, and no connection ------------
const connect = () => ev(`${row}.querySelector('.row__buttons .btn:not(.row__menu)') ? [...${row}.querySelectorAll('.row__buttons .btn')].find((b) => b.textContent.includes('Connect')).click() : null`)
await connect()
await waitFor(`[...document.querySelectorAll('.modal__title')].some((t) => t.textContent.trim() === ${JSON.stringify(TITLE)})`, 'the question after Connect', 45000)
check('Connect asks about the certificate', (await question())?.buttons, ['Cancel', 'Trust and retry'])
await answer('Cancel')
await delay(1500)
check('Cancel leaves it unconnected', await ev(`!!document.querySelector('.workspace')`), false)
check('Cancel leaves it untrusted', await savedTrust(), false)

// --- 3. Connect, and trust it: saved with the connection, and connected ----
await connect()
await waitFor(`[...document.querySelectorAll('.modal__title')].some((t) => t.textContent.trim() === ${JSON.stringify(TITLE)})`, 'the question again', 45000)
await answer('Trust and retry')
await waitFor(`!!document.querySelector('.workspace')`, 'the workspace', 45000)
check('Trust and retry connects', await ev(`!!document.querySelector('.workspace')`), true)
check('the trust is saved with the connection', await savedTrust(), true)
await shot('connected')

console.log(JSON.stringify({ steps, failures }, null, 2))
socket.close()
child.kill('SIGKILL')
if (failures.length > 0) {
  console.log('CERTIFICATE E2E FAIL:', failures.map((f) => f.label).join('; '))
  process.exit(1)
}
console.log('CERTIFICATE E2E PASS')
process.exit(0)
