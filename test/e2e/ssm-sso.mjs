/**
 * Signing in to AWS SSO from the app, against the stand-in AWS CLI with an
 * SSO session that has run out: from *Check prerequisites* in the connection
 * form, which checks again once signed in, and from the dialog connecting
 * raises, which connects once signed in — through the stand-in's session to
 * the test SQL Server, so this suite needs the test environment.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9242
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-ssm-sso`
mkdirSync(SHOTS, { recursive: true })
const TOKEN = `${PROJECT}/.tmp/fake-aws-sso-token`
const ARGS = `${PROJECT}/.tmp/fake-aws-sso-args.json`
rmSync(TOKEN, { force: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-ssm-sso`],
  {
    cwd: PROJECT,
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY ?? ':99',
      // Put the stand-ins ahead of anything real on PATH.
      PATH: `${PROJECT}/.tmp/bin:${process.env.PATH}`,
      // The SSO session has run out until `aws sso login` writes the token;
      // the stand-in's session then forwards to the test SQL Server.
      FAKE_AWS_SCENARIO: 'sso-expired',
      FAKE_AWS_SSO_TOKEN_FILE: TOKEN,
      FAKE_AWS_SSO_DELAY: '4000',
      FAKE_AWS_ARGS_FILE: ARGS,
      FAKE_AWS_UPSTREAM_PORT: '11433'
    }
  }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('SSM SSO E2E FAIL:', message)
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
function check(condition, message) {
  if (!condition) bail(message)
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

const lastArgs = () => (existsSync(ARGS) ? JSON.parse(readFileSync(ARGS, 'utf8')).args : [])

await send('Runtime.enable'); await send('Page.enable')
await waitFor(`!!document.querySelector('.brand__title')`, 'connection screen')

await ev(`(async () => {
  for (const c of await window.api.listConnections()) await window.api.deleteConnection(c.id)
  await window.api.saveConnection({
    name: 'SSO bastion', host: 'db.internal', port: 1433,
    database: 'beekeeper_test', authType: 'sql', username: 'sa',
    password: 'Beekeeper#2024!', savePassword: true,
    options: { encrypt: true, trustServerCertificate: true },
    ssm: {
      enabled: true, credentialSource: 'cli', profile: 'dev', mode: 'remote-host',
      instanceId: 'i-0ba5711000fee1dad', region: 'eu-west-2'
    }
  })
})()`)
await ev('location.reload()')
await delay(1200)
await send('Runtime.enable')
await waitFor(`[...document.querySelectorAll('.row__name')].some(n => n.textContent.trim() === 'SSO bastion')`, 'the saved connection')

// --- 1. Check prerequisites offers to sign in, and checks again after ---------------------
await ev(`[...document.querySelectorAll('.btn')].find(b => b.textContent.includes('New connection')).click()`)
await waitFor(`!!document.querySelector('.form__tabs')`, 'connection form')
await ev(`[...document.querySelectorAll('.form__tab')].find(t => t.textContent.includes('Tunnel')).click()`)
await waitFor(`!!document.querySelector('.seg')`, 'tunnel picker')
await ev(`[...document.querySelectorAll('.seg__opt')].find(c => c.textContent.includes('AWS SSM')).click()`)
await waitFor(`!!document.querySelector('input[placeholder="i-0123456789abcdef0"]')`, 'ssm fields')
await ev(`(() => {
  const select = [...document.querySelectorAll('.form__group select')].find(s => [...s.options].some(o => o.value === 'cli'))
  select.value = 'cli'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
await waitFor(`[...document.querySelectorAll('.field__label')].some(l => l.textContent.trim() === 'AWS profile')`, 'the profile field')
await ev(`(() => {
  const label = [...document.querySelectorAll('.field__label')].find(l => l.textContent.trim() === 'AWS profile')
  const input = label.parentElement.querySelector('input')
  input.value = 'dev'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await ev(`[...document.querySelectorAll('.preflight .btn')].find(b => b.textContent.includes('Check')).click()`)
await waitFor(`!!document.querySelector('.preflight .sso .btn')`, 'the offer to sign in', 40000)
steps.push({
  step: 'prerequisites: expired',
  rows: await ev(`[...document.querySelectorAll('.preflight__row')].map(r => r.textContent.replace(/\\s+/g,' ').trim())`),
  button: await ev(`document.querySelector('.preflight .sso .btn').textContent.trim()`)
})
check(steps.at(-1).button === 'Sign in with AWS SSO', 'the button does not say what it does')
await ev(`document.querySelector('.preflight').scrollIntoView({ block: 'end' })`)
await shot('01-prerequisites-expired')

await ev(`document.querySelector('.preflight .sso .btn').click()`)
await waitFor(`!!document.querySelector('.preflight .sso__waiting')`, 'the waiting state')
await waitFor(`!!document.querySelector('.sso__code') || !!document.querySelector('.sso__link')`, 'what to open', 10000)
steps.push({
  step: 'prerequisites: signing in',
  waiting: await ev(`document.querySelector('.sso__waiting').textContent.trim()`),
  code: await ev(`document.querySelector('.sso__code')?.textContent.trim() ?? null`),
  args: lastArgs()
})
await ev(`document.querySelector('.preflight').scrollIntoView({ block: 'end' })`)
await shot('02-prerequisites-signing-in')
check(steps.at(-1).args.slice(0, 5).join(' ') === 'sso login --no-browser --profile dev', 'the CLI was not asked to sign in for the profile')
// With no browser to hand, a code works from any device.
if (!steps.at(-1).code) {
  await ev(`[...document.querySelectorAll('.sso__link')].find(b => b.textContent.includes('code')).click()`)
  await waitFor(`document.querySelector('.sso__code')?.textContent.trim() === 'WDDD-HRQV'`, 'the device code', 10000)
  steps.push({
    step: 'prerequisites: a code instead',
    url: await ev(`document.querySelector('.sso__url').textContent.trim()`),
    args: lastArgs()
  })
  check(steps.at(-1).args.includes('--use-device-code'), 'the CLI was not asked for a code')
  await ev(`document.querySelector('.preflight').scrollIntoView({ block: 'end' })`)
await shot('02b-prerequisites-code')
}
await waitFor(
  `[...document.querySelectorAll('.preflight__mark')].every(m => m.classList.contains('preflight__mark--ok')) && !document.querySelector('.preflight .sso')`,
  'every prerequisite green after signing in',
  30000
)
steps.push({
  step: 'prerequisites: signed in',
  rows: await ev(`[...document.querySelectorAll('.preflight__row')].map(r => r.textContent.replace(/\\s+/g,' ').trim())`)
})
await ev(`document.querySelector('.preflight').scrollIntoView({ block: 'end' })`)
await shot('03-prerequisites-signed-in')
await ev(`document.querySelector('.modal__close').click()`)
await delay(400)

// --- 2. connecting raises the dialog, which connects once signed in ------------------------
rmSync(TOKEN, { force: true })
await ev(`[...document.querySelectorAll('.row')].find(r => r.querySelector('.row__name').textContent.trim() === 'SSO bastion').querySelector('.row__connect').click()`)
await waitFor(`document.querySelector('.modal__title')?.textContent.includes('expired')`, 'the expired-credentials dialog', 40000)
steps.push({
  step: 'dialog',
  title: await ev(`document.querySelector('.modal__title').textContent.trim()`),
  why: await ev(`document.querySelector('.expired__why')?.textContent.trim()`),
  primary: await ev(`document.querySelector('.modal .btn--primary')?.textContent.trim()`)
})
check(steps.at(-1).primary === 'Sign in with AWS SSO', 'signing in is not the dialog’s action')
await shot('04-dialog')
await ev(`document.querySelector('.modal .sso .btn--primary').click()`)
await waitFor(`!!document.querySelector('.modal .sso__waiting')`, 'the dialog waiting')
await delay(300)
await shot('05-dialog-signing-in')
await ev(`document.documentElement.setAttribute('data-theme', 'light')`)
await shot('05b-dialog-signing-in-light')
await ev(`document.documentElement.setAttribute('data-theme', 'dark')`)
// Cancel stops it; a second go finishes and the connection is retried.
await ev(`[...document.querySelectorAll('.modal .sso .btn')].find(b => b.textContent.trim() === 'Cancel').click()`)
await waitFor(`!document.querySelector('.modal .sso__waiting') && !!document.querySelector('.modal .sso .btn--primary')`, 'the sign-in cancelled')
check(!existsSync(TOKEN), 'the cancelled sign-in still finished')
await ev(`document.querySelector('.modal .sso .btn--primary').click()`)
await waitFor(`!!document.querySelector('.workspace')`, 'the connection, retried after signing in', 60000)
steps.push({ step: 'connected', args: lastArgs().slice(0, 2), title: await ev(`document.title`) })
check(steps.at(-1).args.join(' ') === 'ssm start-session', 'the retry did not start a session')
await delay(800)
await shot('06-connected')

const rendererErrors = logs.join('').split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif|xdg-open|NODE_OPTION/i.test(l))
check(rendererErrors.length === 0, 'the renderer logged errors:\n' + rendererErrors.join('\n'))

rmSync(TOKEN, { force: true })
console.log('SSM SSO E2E PASS')
console.log(JSON.stringify(steps, null, 2))
child.kill('SIGKILL')
process.exit(0)
