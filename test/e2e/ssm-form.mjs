/**
 * Verifies the tunnel picker, the bastion instance picker and the AWS SSM
 * preflight in the real UI.
 *
 * `.tmp/bin` holds stand-ins for `aws` and `session-manager-plugin` (written by
 * scripts/e2e.sh), so the instance list and both the pass and fail states of
 * the prerequisite check can be shown without an AWS account or a real install.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9227
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-ssm`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-ssm`],
  {
    cwd: PROJECT,
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY ?? ':99',
      // Put the stand-ins ahead of anything real on PATH.
      PATH: `${PROJECT}/.tmp/bin:${process.env.PATH}`
    }
  }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('SSM FORM E2E FAIL:', message)
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

await send('Runtime.enable'); await send('Page.enable')
await waitFor(`!!document.querySelector('.brand__title')`, 'connection screen')

// Start from a clean slate.
await ev(`(async () => { for (const c of await window.api.listConnections()) await window.api.deleteConnection(c.id) })()`)
await ev('location.reload()')
await delay(1200)
await send('Runtime.enable')
await waitFor(`!!document.querySelector('.brand__title')`, 'reloaded')

// Open the new-connection form and go to the Tunnel tab.
await ev(`[...document.querySelectorAll('.btn')].find(b => b.textContent.includes('New connection')).click()`)
await waitFor(`!!document.querySelector('.form__tabs')`, 'connection form')
await ev(`[...document.querySelectorAll('.form__tab')].find(t => t.textContent.includes('Tunnel')).click()`)
await waitFor(`!!document.querySelector('.seg')`, 'tunnel picker')

steps.push({
  step: 'tunnel picker',
  choices: await ev(`[...document.querySelectorAll('.seg__opt')].map(e => e.textContent.trim())`),
  active: await ev(`document.querySelector('.seg__opt--on')?.textContent?.trim()`)
})
await shot('01-tunnel-picker')

// Choose AWS SSM.
await ev(`[...document.querySelectorAll('.seg__opt')].find(c => c.textContent.includes('AWS SSM')).click()`)
await waitFor(`!!document.querySelector('input[placeholder="i-0123456789abcdef0"]')`, 'ssm fields')
steps.push({
  step: 'ssm selected',
  active: await ev(`document.querySelector('.seg__opt--on')?.textContent?.trim()`),
  fields: await ev(`[...document.querySelectorAll('.form__group .field__label')].map(e => e.textContent.trim())`)
})

// Invalid instance id should be rejected inline.
await setInput('input[placeholder="i-0123456789abcdef0"]', 'not-an-instance')
await delay(300)
steps.push({
  step: 'validation',
  error: await ev(`document.querySelector('.form__group .error-text')?.textContent?.trim() ?? null`),
  saveDisabled: await ev(`document.querySelector('button[type=submit]').disabled`)
})

// Now a valid one.
await setInput('input[placeholder="i-0123456789abcdef0"]', 'i-0123456789abcdef0')
await delay(300)
steps.push({
  step: 'validation cleared',
  error: await ev(`document.querySelector('.form__group .error-text')?.textContent?.trim() ?? null`),
  saveDisabled: await ev(`document.querySelector('button[type=submit]').disabled`)
})

// Paste credentials the way the portal hands them out. They now belong to the
// connection, so they are saved with it rather than applied globally.
steps.push({
  step: 'credentials required before save',
  blocked: await ev(`document.querySelector('.form__group .error-text')?.textContent?.trim() ?? null`)
})

// The paste button reads the clipboard in the main process, which hands over
// a credentials block and nothing else: whatever else was copied stays put.
const pasteButton = `[...document.querySelectorAll('.credbox__paste')].find(b => b.textContent.includes('Paste from clipboard'))`
await ev(`window.api.copyToClipboard('hunter2 is not a credentials block')`)
await ev(`${pasteButton}.click()`)
await waitFor(
  `document.querySelector('.credbox__status')?.textContent.includes('does not hold AWS credentials')`,
  'the clipboard turned down'
)
steps.push({
  step: 'paste with the wrong thing copied',
  status: await ev(`document.querySelector('.credbox__status')?.textContent?.replace(/\\s+/g,' ').trim()`),
  boxStillEmpty: await ev(`document.querySelector('.credbox__box').value === ''`),
  invalid: await ev(`document.querySelector('.credbox__box').getAttribute('aria-invalid')`)
})
if (!(await ev(`document.querySelector('.credbox__box').value === ''`))) {
  bail('non-credential clipboard text reached the box')
}
await shot('02a-clipboard-turned-down')

await ev(`window.api.copyToClipboard(${JSON.stringify([
  'export AWS_ACCESS_KEY_ID="ASIAIOSFODNN7EXAMPLE"',
  'export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
  'export AWS_SESSION_TOKEN="IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJH"',
  'export AWS_DEFAULT_REGION="eu-west-2"'
].join('\n'))})`)
await ev(`${pasteButton}.click()`)
await waitFor(
  `document.querySelector('.credbox__box').value.includes('AWS_SESSION_TOKEN')`,
  'the pasted block in the box'
)
await waitFor(
  `document.querySelector('.credbox__status--found')?.textContent.includes('ASIA************MPLE')`,
  'what the pasted block holds'
)
steps.push({
  step: 'credentials pasted from the clipboard',
  status: await ev(`document.querySelector('.credbox__status')?.textContent?.replace(/\\s+/g,' ').trim()`),
  blockCleared: await ev(`document.querySelector('.form__group .error-text')?.textContent?.trim() ?? null`)
})
await shot('02-credentials-pasted')

// The pasted block named a region, so the field should already hold it — the
// instance list is per region, and nothing can be fetched without one.
steps.push({
  step: 'region from the pasted block',
  region: await ev(`document.querySelector('input[list="ssm-regions"]')?.value`),
  fetchEnabled: await ev(`!document.querySelector('.instances__fetch').disabled`)
})

// Fetch the account's instances and pick the bastion by name, rather than
// relying on an ID that changes with every deployment.
await ev(`document.querySelector('.instances__fetch').click()`)
await waitFor(`document.querySelectorAll('.instances__select option').length > 1`, 'instance list', 40000)
steps.push({
  step: 'instances fetched',
  label: await ev(`document.querySelector('.instances .field__label')?.textContent?.replace(/\\s+/g,' ').trim()`),
  options: await ev(`[...document.querySelectorAll('.instances__select option')].map(o => o.textContent.trim())`)
})
await shot('03-instances-fetched')

await ev(`
  (() => {
    const select = document.querySelector('.instances__select')
    select.value = [...select.options].map(o => o.value).find(v => v.startsWith('i-'))
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return select.value
  })()
`)
await delay(300)
steps.push({
  step: 'bastion picked',
  instanceId: await ev(`document.querySelector('input[placeholder="i-0123456789abcdef0"]').value`),
  hint: await ev(`document.querySelector('.instances .field__hint')?.textContent?.replace(/\\s+/g,' ').trim()`),
  saveDisabled: await ev(`document.querySelector('button[type=submit]').disabled`)
})

// The other way of naming the bastion: the Name tag, which outlives the ID.
// Picking from the list has to fill that in instead, and the form has to say
// what the name resolves to right now.
await ev(`
  (() => {
    // Scoped to the form: the list screen behind it has pickers of its own.
    const select = [...document.querySelectorAll('.form select')].find(
      (s) => [...s.options].some((o) => o.value === 'name')
    )
    select.value = 'name'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()
`)
await waitFor(`!!document.querySelector('input[placeholder="prod-bastion"]')`, 'bastion name field')
await ev(`
  (() => {
    const select = document.querySelector('.instances__select')
    select.value = [...select.options].map(o => o.value).find(v => v.startsWith('i-'))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()
`)
await delay(300)
steps.push({
  step: 'bastion named',
  name: await ev(`document.querySelector('input[placeholder="prod-bastion"]').value`),
  hint: await ev(`document.querySelector('.instances .field__hint')?.textContent?.replace(/\\s+/g,' ').trim()`),
  saveDisabled: await ev(`document.querySelector('button[type=submit]').disabled`)
})
await shot('04-bastion-named')

// A name nothing answers to is the redeploy case, and must be called out here
// rather than at the moment the connection is opened.
await setInput('input[placeholder="prod-bastion"]', 'no-such-bastion')
await delay(300)
steps.push({
  step: 'unknown name',
  hints: await ev(`[...document.querySelectorAll('.instances .field__hint')].map(h => h.textContent.replace(/\\s+/g,' ').trim())`)
})

// Back to an ID for the rest of the run.
await ev(`
  (() => {
    // Scoped to the form: the list screen behind it has pickers of its own.
    const select = [...document.querySelectorAll('.form select')].find(
      (s) => [...s.options].some((o) => o.value === 'instance-id')
    )
    select.value = 'instance-id'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()
`)
await waitFor(`!!document.querySelector('input[placeholder="i-0123456789abcdef0"]')`, 'instance id field')

// A region with nothing in it is a common mistake, and must say so rather than
// leaving the last region's list on screen.
await setInput('input[list="ssm-regions"]', 'us-east-1')
await delay(300)
await ev(`document.querySelector('.instances__fetch').click()`)
await waitFor(
  `[...document.querySelectorAll('.instances .field__hint')].some(h => h.textContent.includes('Nothing in this region'))`,
  'empty region message',
  40000
)
steps.push({
  step: 'wrong region',
  options: await ev(`document.querySelectorAll('.instances__select option').length`),
  hint: await ev(`[...document.querySelectorAll('.instances .field__hint')].map(h => h.textContent.replace(/\\s+/g,' ').trim())`)
})

// Back to the region the bastion is actually in.
await setInput('input[list="ssm-regions"]', 'eu-west-2')
await delay(300)
await ev(`document.querySelector('.instances__fetch').click()`)
await waitFor(`document.querySelectorAll('.instances__select option').length > 1`, 'instance list again', 40000)

// Preflight with a bogus CLI path — expect a failure row for the CLI.
await setInput('input[placeholder="aws (found on PATH)"]', '/nonexistent/aws')
await delay(200)
await ev(`[...document.querySelectorAll('.preflight .btn')].find(b => b.textContent.includes('Check')).click()`)
await waitFor(`!!document.querySelector('.preflight__results')`, 'preflight results', 40000)
await delay(400)
steps.push({
  step: 'preflight with a bad CLI path',
  rows: await ev(`[...document.querySelectorAll('.preflight__row')].map(r => r.textContent.replace(/\\s+/g,' ').trim())`)
})
await shot('04-preflight-failure')

// Clear the path so the stand-in on PATH is used — expect all green.
await setInput('input[placeholder="aws (found on PATH)"]', '')
await delay(200)
await ev(`[...document.querySelectorAll('.preflight .btn')].find(b => b.textContent.includes('Check')).click()`)
await waitFor(
  `[...document.querySelectorAll('.preflight__mark')].every(m => m.classList.contains('preflight__mark--ok'))`,
  'all prerequisites green',
  40000
)
steps.push({
  step: 'preflight success',
  rows: await ev(`[...document.querySelectorAll('.preflight__row')].map(r => r.textContent.replace(/\\s+/g,' ').trim())`)
})
await shot('05-preflight-success')

// Fill the rest and save, then confirm it round-trips through storage.
await ev(`[...document.querySelectorAll('.form__tab')].find(t => t.textContent.includes('General')).click()`)
await waitFor(`!!document.querySelector('input[placeholder="Production reporting"]')`, 'general tab')
await setInput('input[placeholder="Production reporting"]', 'Prod via bastion')
await setInput('input[placeholder="localhost"]', 'prod.abc123.eu-west-2.rds.amazonaws.com')
await delay(300)
await ev(`document.querySelector('button[type=submit]').click()`)
await waitFor(`!!document.querySelector('.row')`, 'saved connection row', 20000)

steps.push({
  step: 'saved',
  stored: await ev(`
    (async () => {
      const list = await window.api.listConnections()
      const c = list[0]
      return JSON.stringify({
        name: c.name,
        host: c.host,
        hasSavedAwsCredentials: c.hasSavedAwsCredentials,
        ssm: c.ssm,
        sshEnabled: c.ssh.enabled
      })
    })()
  `),
  // The secret must never come back to the renderer, even after saving.
  secretReachesRenderer: await ev(`
    (async () => JSON.stringify(await window.api.listConnections()).includes('wJalrXUtnFEMI'))()
  `),
  rowSubtitle: await ev(`document.querySelector('.row__sub')?.textContent?.trim()`)
})

// Reopen the saved connection: the summary should be there, the box empty.
await ev(`document.querySelector('.row__menu').click()`)
await waitFor(`!!document.querySelector('.menu')`, 'the row\u2019s ⋮ menu')
await ev(`[...document.querySelectorAll('.menu .menu__item')].find(b => b.textContent.trim().startsWith('Edit')).click()`)
await waitFor(`!!document.querySelector('.form__tabs')`, 'edit form')
await ev(`[...document.querySelectorAll('.form__tab')].find(t => t.textContent.includes('Tunnel')).click()`)
await waitFor(`!!document.querySelector('.creds__current')`, 'stored credential summary')
steps.push({
  step: 'reopened',
  summary: await ev(`document.querySelector('.creds__key')?.textContent?.trim()`),
  savedAt: await ev(`document.querySelector('.creds__arn')?.textContent?.trim()`),
  boxEmpty: await ev(`document.querySelector('.credbox__box').value === ''`),
  secretInDom: await ev(`document.body.innerHTML.includes('wJalrXUtnFEMI')`)
})
await shot('07-reopened')
await ev(`document.querySelector('.modal__close').click()`)
await delay(400)

// Credentials that have run out are pasted again far more often than they are
// first set up, so the dialog that asks for fresh ones has the button too. A
// saved block whose expiry has passed raises it before any AWS call is made.
await ev(`
  (async () => {
    await window.api.saveConnection({
      name: 'Expired portal block',
      host: 'db.internal',
      username: 'sa',
      password: 'x',
      savePassword: true,
      ssm: {
        enabled: true,
        credentialSource: 'pasted',
        instanceId: 'i-0ba5711000fee1dad',
        credentialsText: [
          'AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE',
          'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          'AWS_CREDENTIAL_EXPIRATION=2020-01-01T00:00:00Z'
        ].join('\\n')
      }
    })
  })()
`)
await ev('location.reload()')
await delay(1200)
await send('Runtime.enable')
await waitFor(`[...document.querySelectorAll('.row__name')].some(n => n.textContent.trim() === 'Expired portal block')`, 'the expired connection')
await ev(`[...document.querySelectorAll('.row')].find(r => r.querySelector('.row__name').textContent.trim() === 'Expired portal block').querySelector('.row__connect').click()`)
await waitFor(`document.querySelector('.modal__title')?.textContent.includes('expired')`, 'the expired-credentials dialog')
await ev(`window.api.copyToClipboard(${JSON.stringify([
  'export AWS_ACCESS_KEY_ID="ASIAIOSFODNN7EXAMPLE"',
  'export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
  'export AWS_SESSION_TOKEN="IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJH"',
  'export AWS_CREDENTIAL_EXPIRATION="2099-01-01T00:00:00Z"'
].join('\n'))})`)
const boxFocused = await ev(`document.activeElement === document.querySelector('.modal .credbox__box')`)
await ev(`document.querySelector('.modal .credbox__paste').click()`)
await waitFor(`document.querySelector('.modal .credbox__status--found')`, 'the fresh block, read')
steps.push({
  step: 'expired credentials, pasted from the clipboard',
  title: await ev(`document.querySelector('.modal__title')?.textContent?.trim()`),
  boxFocusedOnOpen: boxFocused,
  status: await ev(`document.querySelector('.modal .credbox__status')?.textContent?.replace(/\\s+/g,' ').trim()`),
  saveEnabled: await ev(`![...document.querySelectorAll('.modal .btn')].find(b => b.textContent.includes('Save and retry')).disabled`)
})
await shot('08-expired-pasted')
// Saving would start a session, which this suite has no SSM for.
await ev(`[...document.querySelectorAll('.modal .btn')].find(b => b.textContent.trim() === 'Cancel').click()`)
await delay(300)

// A second window must open, and be independent of the first.
const before = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(
  (t) => t.type === 'page'
).length
await ev(`(async () => { await window.api.openNewWindow() })()`)
await delay(2500)
const after = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(
  (t) => t.type === 'page'
).length
steps.push({ step: 'new window', pagesBefore: before, pagesAfter: after })
await shot('06-saved')

const rendererErrors = logs.join('').split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif/i.test(l))
  // The paste with the wrong thing copied deliberately provokes this one.
  .filter((l) => !l.includes('clipboard:awsCredentials failed'))

console.log(JSON.stringify({ steps, rendererErrors }, null, 2))
socket.close(); child.kill('SIGKILL'); process.exit(0)
