/**
 * Drives the query editor's completion through the real app: the columns of
 * the tables a statement reads, bare and after an alias (bracketed names
 * included), and snippets — made in the Snippets dialog, inserted from
 * completion, and Tab moving between their placeholders.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9241
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-editor`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-editor`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('EDITOR E2E FAIL:', message)
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
const KEY_CODES = { Escape: 27, ArrowRight: 39, ArrowDown: 40, ArrowUp: 38, End: 35, Enter: 13, Tab: 9, Backspace: 8, ' ': 32, a: 65, F5: 116, c: 67, l: 76, m: 77, p: 80, t: 84, v: 86 }
const press = async (key, modifiers = 0) => {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
  const base = { key, code, windowsVirtualKeyCode: KEY_CODES[key], modifiers }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
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

const runSql = (sql) =>
  ev(`(async () => {
    const [connection] = await window.api.listConnections()
    const result = await window.api.runQuery({ connectionId: connection.id, sql: ${JSON.stringify(sql)} })
    return result.statements.map((s) => s.error?.message ?? 'ok')
  })()`)

await ev(`[...document.querySelectorAll('.row__buttons .btn')].find(b=>b.textContent.includes('Connect')).click()`)
await waitFor(`!!document.querySelector('.workspace')`, 'workspace', 45000)
await waitFor(`!!document.querySelector('.sidebar__tabs')`, 'sidebar')

check(
  (
    await runSql(`DROP TABLE IF EXISTS dbo.e2e_customers;
DROP TABLE IF EXISTS dbo.[e2e order lines];
GO
CREATE TABLE dbo.e2e_customers (id int PRIMARY KEY, name nvarchar(40), city nvarchar(40));
CREATE TABLE dbo.[e2e order lines] (order_id int, [unit price] decimal(10, 2));`)
  ).every((s) => s === 'ok'),
  'could not create the tables'
)
// Completion reads the columns the schema store loaded, which predates the tables.
await ev(`document.querySelector('.sidebar__db-btn[aria-label="Refresh"]').click()`)
await waitFor(
  `[...document.querySelectorAll('.sidebar .item__name')].some(e => e.textContent.trim() === 'e2e_customers')`,
  'the new table in the tree'
)
await delay(1000)

await waitFor(`!!document.querySelector('.cm-content')`, 'the editor')
/** Replaces the editor's text, leaving the cursor at the end. */
const setText = async (text) => {
  await ev(`document.querySelector('.cm-content').focus()`)
  await press('a', 2)
  await press('Backspace')
  await send('Input.insertText', { text })
}
const type = async (text) => {
  for (const ch of text) await send('Input.insertText', { text: ch })
}
const options = () =>
  ev(`[...document.querySelectorAll('.cm-tooltip-autocomplete li')].map(li =>
    li.querySelector('.cm-completionLabel').textContent + ':' + (li.querySelector('.cm-completionDetail')?.textContent ?? ''))`)
const waitOptions = (label) => waitFor(`document.querySelectorAll('.cm-tooltip-autocomplete li').length > 0`, label, 5000)
const text = () => ev(`document.querySelector('.cm-content').innerText.replace(/ /g, ' ')`)
const closeCompletion = async () => {
  if (await ev(`!!document.querySelector('.cm-tooltip-autocomplete')`)) await press('Escape')
}

// --- 1. a bare word, the FROM after the cursor -------------------------------------------
await setText('SELECT \nFROM dbo.e2e_customers c')
await press('ArrowUp')
await press('End')
await type('na')
await waitOptions('completion for a bare word')
steps.push({ step: 'bare word', options: (await options()).slice(0, 5) })
check(steps.at(-1).options[0] === 'name:e2e_customers', 'the column was not offered first')
await shot('01-bare-word')
await press('Enter')
await delay(200)
check((await text()).startsWith('SELECT name\n'), 'picking the column did not insert it: ' + (await text()))

// --- 2. after an alias: only that table's columns -----------------------------------------
await press('End')
await type(', c.')
await waitOptions('completion after c.')
steps.push({ step: 'alias', options: await options() })
check(
  JSON.stringify(steps.at(-1).options.map((o) => o.split(':')[0]).sort()) === JSON.stringify(['city', 'id', 'name']),
  'the alias did not offer exactly its table’s columns'
)
await shot('02-alias')
await closeCompletion()

// --- 3. a bracketed table and a column that needs brackets ---------------------------------
await setText('SELECT \nFROM [e2e order lines] AS l')
await press('ArrowUp')
await press('End')
await type('l.u')
await waitOptions('completion after l.')
steps.push({ step: 'bracketed', options: await options() })
check(
  JSON.stringify(steps.at(-1).options) === JSON.stringify(['unit price:e2e order lines']),
  'after l.u only the bracketed table’s column belongs in the list'
)
await press('Enter')
await delay(200)
check((await text()).startsWith('SELECT l.[unit price]\n'), 'the column was not bracketed: ' + (await text()))

// --- 4. nothing where a table goes ---------------------------------------------------------
await setText('SELECT * FROM e2e_c')
await waitOptions('completion after FROM')
steps.push({ step: 'after FROM', options: await options() })
check(steps.at(-1).options.some((o) => o.startsWith('e2e_customers')), 'the table was not offered after FROM')
check(!steps.at(-1).options.some((o) => o.endsWith(':e2e_customers')), 'columns were offered after FROM')
await closeCompletion()

// --- 5. a starter snippet, above the keyword it shares letters with ------------------------
await setText('')
await type('tran')
await waitOptions('completion for tran')
steps.push({ step: 'starter', options: (await options()).slice(0, 3) })
check(steps.at(-1).options[0] === 'tran:Guarded transaction', 'the tran snippet was not first')
await waitFor(`!!document.querySelector('.cm-snippetInfo pre')`, 'the snippet preview', 5000)
await shot('03-starter-snippet')
await press('Enter')
await delay(200)
steps.push({ step: 'starter inserted', text: await text(), selected: await ev(`getSelection().toString()`) })
check(steps.at(-1).text.startsWith('BEGIN TRAN;'), 'the snippet was not inserted')
check(steps.at(-1).selected === '-- statements', 'its placeholder was not selected')
await press('Escape')

// --- 6. a snippet of our own, made in the dialog -------------------------------------------
await ev(`[...document.querySelectorAll('.titlebar__menu')].find(b => b.textContent.trim() === 'Query').click()`)
await waitFor(`!!document.querySelector('.titlebar__dropdown')`, 'the Query menu')
await ev(`[...document.querySelectorAll('.titlebar__dropdown .titlebar__item')].find(i => i.textContent.includes('Snippets')).click()`)
await waitFor(`document.querySelectorAll('.snippets__item').length > 0`, 'the snippets dialog')
steps.push({ step: 'dialog', listed: await ev(`[...document.querySelectorAll('.snippets__prefix')].map(e => e.textContent)`) })
check(steps.at(-1).listed.includes('tran'), 'the starters are not listed')

await ev(`[...document.querySelectorAll('.snippets .btn')].find(b => b.textContent.includes('New snippet')).click()`)
await waitFor(`document.activeElement?.closest('.snippets__edit') !== null`, 'the name box to take the focus')
await send('Input.insertText', { text: 'Audit columns' })
// A save with no prefix is turned down, on the snippet it is about.
await ev(`[...document.querySelectorAll('.modal__foot .btn')].find(b => b.textContent.trim() === 'Save').click()`)
await waitFor(`!!document.querySelector('.snippets__problem')`, 'the missing prefix to be pointed out')
steps.push({ step: 'problem', problem: await ev(`document.querySelector('.snippets__problem').textContent.trim()`) })
const fill = (selector, value) =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    el.value = ${JSON.stringify(value)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
await fill('.snippets__prefix-field input', 'audit')
await fill('.snippets__body', 'created_at = ${1:SYSDATETIME()},\ncreated_by = ${2:SUSER_SNAME()}')
await waitFor(`document.querySelector('.snippets__preview pre').textContent.includes('created_by = SUSER_SNAME()')`, 'the preview')
await shot('04-snippets-dialog')
await ev(`[...document.querySelectorAll('.modal__foot .btn')].find(b => b.textContent.trim() === 'Save').click()`)
await waitFor(`!document.querySelector('.snippets')`, 'the dialog to close on Save')
steps.push({ step: 'saved', stored: await ev(`window.api.listSnippets().then(l => l.find(s => s.prefix === 'audit'))`) })
check(steps.at(-1).stored?.name === 'Audit columns', 'the snippet was not stored')

await setText('UPDATE dbo.e2e_customers SET ')
await type('aud')
await waitOptions('completion for aud')
steps.push({ step: 'own snippet', options: (await options()).slice(0, 2) })
check(steps.at(-1).options[0] === 'audit:Audit columns', 'the new snippet was not offered')
await press('Enter')
await delay(200)
const first = await ev(`getSelection().toString()`)
await press('Tab')
await delay(100)
const second = await ev(`getSelection().toString()`)
steps.push({ step: 'tab stops', text: await text(), first, second })
check(first === 'SYSDATETIME()' && second === 'SUSER_SNAME()', 'Tab did not move between the placeholders')
check(
  steps.at(-1).text === 'UPDATE dbo.e2e_customers SET created_at = SYSDATETIME(),\ncreated_by = SUSER_SNAME()',
  'the snippet text came out wrong'
)
await shot('05-own-snippet')
await press('Escape')

await runSql('DROP TABLE IF EXISTS dbo.e2e_customers; DROP TABLE IF EXISTS dbo.[e2e order lines];')

const rendererErrors = logs.join('').split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif/i.test(l))
check(rendererErrors.length === 0, 'the renderer logged errors:\n' + rendererErrors.join('\n'))

console.log('EDITOR E2E PASS')
console.log(JSON.stringify(steps, null, 2))
child.kill('SIGKILL')
process.exit(0)
