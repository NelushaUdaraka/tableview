/**
 * Drives the table browser's own tools through the real app: picking the
 * columns the grid shows — which reads nothing, and is kept by the tab — the
 * filter bar's Clear filters, and a toolbar that still fits in a narrow pane.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9233
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-table-tools`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-table-tools`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('TABLE TOOLS E2E FAIL:', message)
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
const KEY_CODES = { Escape: 27, ArrowRight: 39, Enter: 13, c: 67 }
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
    await runSql(`DROP TABLE IF EXISTS dbo.e2e_tools;
GO
CREATE TABLE dbo.e2e_tools (
  id int IDENTITY(1,1) PRIMARY KEY,
  name nvarchar(50) NOT NULL,
  status varchar(20) NOT NULL,
  note nvarchar(100) NULL,
  created_on date NOT NULL DEFAULT ('2024-01-01')
);
GO
INSERT INTO dbo.e2e_tools (name, status, note) VALUES
  (N'one', 'new', N'first'), (N'two', 'done', NULL), (N'three', 'new', N'third'), (N'four', 'done', N'last');`)
  ).every((s) => s === 'ok'),
  'could not create the table'
)
const insert = (name, status = 'new') =>
  runSql(`INSERT INTO dbo.e2e_tools (name, status) VALUES (N'${name}', '${status}')`)

const headers = () => ev(`[...document.querySelectorAll('.grid__th-name')].map(e => e.textContent.trim())`)
const rowsLabel = () => ev(`document.querySelector('.data__rows')?.textContent.trim()`)
const columnsButton = () =>
  ev(`(() => {
    const button = document.querySelector('.data__columns')
    return button && {
      count: button.querySelector('.data__columns-count')?.textContent.trim() ?? null,
      armed: button.classList.contains('btn--armed'),
      expanded: button.getAttribute('aria-expanded'),
      name: button.getAttribute('aria-label')
    }
  })()`)
const picker = () =>
  ev(`(() => {
    const panel = document.querySelector('.popover[role=dialog]')
    if (!panel) return null
    return {
      rows: [...panel.querySelectorAll('.picker__row')].map((row) => ({
        name: row.querySelector('.picker__name').textContent.trim(),
        shown: row.querySelector('input').checked
      })),
      count: panel.querySelector('.picker__count').textContent.trim(),
      buttons: [...panel.querySelectorAll('.picker__foot .btn')].map((b) => b.textContent.trim() + (b.disabled ? ' (off)' : ''))
    }
  })()`)
const tick = (name) =>
  ev(`[...document.querySelectorAll('.picker__row')].find(r => r.querySelector('.picker__name').textContent.trim() === '${name}').querySelector('input').click()`)
const footButton = (label) =>
  ev(`[...document.querySelectorAll('.picker__foot .btn')].find(b => b.textContent.trim() === '${label}').click()`)
const openPicker = async () => {
  if (!(await picker())) await ev(`document.querySelector('.data__columns').click()`)
  await waitFor(`!!document.querySelector('.popover[role=dialog] .picker__row')`, 'the columns picker')
}
const openTable = async (name) => {
  await ev(`[...document.querySelectorAll('.sidebar .item__name')].find(e => e.textContent.trim() === '${name}').closest('.item').click()`)
  await waitFor(`document.querySelector('.tab--active .tab__title')?.textContent.trim() === '${name}'`, `the ${name} tab`)
}

// --- 1. the picker hangs from its button and lists every column ticked --------
await ev(`document.querySelector('.sidebar__db-btn[title^="Refresh"]').click()`)
await waitFor(`[...document.querySelectorAll('.sidebar .item__name')].some(e => e.textContent.trim() === 'e2e_tools')`, 'the table in the tree')
await openTable('e2e_tools')
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('4 rows')`, 'four rows')
const allColumns = ['id', 'name', 'status', 'note', 'created_on']
check(JSON.stringify(await headers()) === JSON.stringify(allColumns), 'the table does not open on every column')
check(!(await columnsButton()).armed, 'the Columns button is lit with nothing hidden')

await openPicker()
const placement = await ev(`(() => {
  const button = document.querySelector('.data__columns').getBoundingClientRect()
  const panel = document.querySelector('.popover').getBoundingClientRect()
  return { rightEdgeOff: Math.abs(button.right - panel.right), gap: panel.top - button.bottom, focus: document.activeElement?.getAttribute('aria-label') }
})()`)
steps.push({ step: 'picker opened', placement, picker: await picker(), button: await columnsButton() })
check(placement.rightEdgeOff < 1 && placement.gap >= 0 && placement.gap <= 8, 'the picker is not lined up under its button')
check(placement.focus === 'Find a column', 'the focus does not start in the search')
check(
  JSON.stringify(steps.at(-1).picker.rows) === JSON.stringify(allColumns.map((name) => ({ name, shown: true }))),
  'the picker does not list every column, ticked'
)
check(steps.at(-1).picker.count === '5 of 5 shown', 'the picker does not count the columns')
check(steps.at(-1).button.expanded === 'true', 'the button does not say the picker is open')
await shot('01-picker')

// --- 2. a column hidden goes at once, and nothing is read for it ----------------
// A row written from outside stays out of the grid unless the table is read
// again — which hiding a column must not do.
check((await insert('five')).every((s) => s === 'ok'), 'could not insert')
await tick('note')
await waitFor(`![...document.querySelectorAll('.grid__th-name')].some(e => e.textContent.trim() === 'note')`, 'the note column going')
steps.push({ step: 'note hidden', headers: await headers(), rows: await rowsLabel(), button: await columnsButton(), picker: await picker() })
check(JSON.stringify(steps.at(-1).headers) === JSON.stringify(['id', 'name', 'status', 'created_on']), 'the grid still shows the hidden column')
check(steps.at(-1).rows === '4 rows', 'hiding a column read the table again')
check(steps.at(-1).button.armed && steps.at(-1).button.count === '4/5', 'the button does not say how many columns are shown')
check(steps.at(-1).picker.count === '4 of 5 shown', 'the picker does not count the hidden column')
await shot('02-hidden')

// --- 3. the search narrows the list, and the foot acts on what is listed ---------
await send('Input.insertText', { text: 'at' })
await waitFor(`document.querySelectorAll('.picker__row').length === 2`, 'the search narrowing the list')
steps.push({ step: 'searched', picker: await picker() })
check(
  JSON.stringify(steps.at(-1).picker.rows.map((row) => row.name)) === JSON.stringify(['status', 'created_on']),
  'the search did not find the columns with "at" in their names'
)
check(steps.at(-1).picker.buttons.includes('Hide matching'), 'the foot does not act on the matches')
await footButton('Hide matching')
await waitFor(`document.querySelectorAll('.grid__th-name').length === 2`, 'the matching columns going')
check(JSON.stringify(await headers()) === JSON.stringify(['id', 'name']), 'Hide matching hid the wrong columns')

// Escape empties the search first, and only then closes.
await press('Escape')
await delay(200)
check(!!(await picker()) && (await ev(`document.querySelector('.picker__input').value`)) === '', 'Escape did not clear the search first')
check((await picker()).rows.length === 5, 'the list did not come back with the search cleared')
await press('Escape')
await waitFor(`!document.querySelector('.popover')`, 'the picker closing')
check(await ev(`document.activeElement === document.querySelector('.data__columns')`), 'the focus did not go back to the button')

// --- 4. the header menu hides and shows ---------------------------------------
await openPicker()
await footButton('Show all')
await waitFor(`document.querySelectorAll('.grid__th-name').length === 5`, 'every column back')
await press('Escape')
await waitFor(`!document.querySelector('.popover')`, 'the picker closing')
await ev(`(() => {
  const header = [...document.querySelectorAll('.grid__th')].find(h => h.querySelector('.grid__th-name').textContent.trim() === 'name')
  const r = header.getBoundingClientRect()
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 10, clientY: r.y + 10 }))
  return true
})()`)
await waitFor(`!!document.querySelector('.menu')`, 'the header menu')
const headerMenu = await ev(`[...document.querySelectorAll('.menu .menu__item')].map(b => b.textContent.trim() + (b.disabled ? ' (off)' : ''))`)
steps.push({ step: 'header menu', headerMenu })
check(headerMenu.includes('Hide this column') && headerMenu.includes('Show all columns (off)'), 'the header menu does not offer hiding')
await ev(`[...document.querySelectorAll('.menu .menu__item')].find(b => b.textContent.trim() === 'Hide this column').click()`)
await waitFor(`![...document.querySelectorAll('.grid__th-name')].some(e => e.textContent.trim() === 'name')`, 'the name column going')
check(JSON.stringify(await headers()) === JSON.stringify(['id', 'status', 'note', 'created_on']), 'the header menu hid the wrong column')

// --- 5. the keyboard, the row panel and a copy go by the columns on show --------
await ev(`(() => {
  const cell = document.querySelectorAll('.grid__row')[1].querySelectorAll('.grid__cell')[0]
  cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return true
})()`)
await ev(`document.querySelector('.grid__viewport').focus()`)
await press('ArrowRight')
await delay(200)
const selectedHeader = () =>
  ev(`(() => {
    const cell = document.querySelector('.grid__cell--selected')
    if (!cell) return null
    const index = [...cell.parentElement.querySelectorAll('.grid__cell')].indexOf(cell)
    return document.querySelectorAll('.grid__th-name')[index]?.textContent.trim()
  })()`)
steps.push({ step: 'arrow right', selected: await selectedHeader() })
check(steps.at(-1).selected === 'status', 'the keyboard stopped on a hidden column')

if (!(await ev(`!!document.querySelector('.rowpanel')?.offsetParent`))) {
  await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.trim() === 'Row details').click()`)
}
await waitFor(`document.querySelectorAll('.rowpanel__name').length > 0`, 'the row panel')
steps.push({
  step: 'row panel',
  fields: await ev(`[...document.querySelectorAll('.rowpanel__name')].map(e => e.textContent.trim())`),
  selected: await ev(`document.querySelector('.rowpanel__field--selected .rowpanel__name')?.textContent.trim() ?? null`)
})
check(JSON.stringify(steps.at(-1).fields) === JSON.stringify(['id', 'status', 'note', 'created_on']), 'the row panel shows a hidden column')
check(steps.at(-1).selected === 'status', 'the row panel is not on the selected column')

await press('c', 2 | 8 /* Ctrl+Shift */)
await delay(300)
await send('Page.bringToFront')
const copied = await ev(`navigator.clipboard.readText()`)
steps.push({ step: 'copied row', copied })
const fields = copied.split('\t')
check(fields.length === 4 && fields[0] === '2' && fields[1] === 'done', 'a copied row is not the columns on show')
await shot('03-panel-and-keyboard')

// --- 6. the tab keeps them across a trip to another tab -------------------------
await openTable('customers')
await waitFor(`document.querySelectorAll('.grid__th-name').length === 7`, 'customers showing every column')
check(!(await columnsButton()).armed, 'hidden columns leaked into another table')
await openTable('e2e_tools')
await waitFor(`document.querySelectorAll('.grid__th-name').length === 4`, 'the hidden column kept by the tab')
check(JSON.stringify(await headers()) === JSON.stringify(['id', 'status', 'note', 'created_on']), 'the tab did not keep its columns')

// --- 7. every column hidden says so, and offers them back -----------------------
await openPicker()
await footButton('Hide all')
await waitFor(`!!document.querySelector('.grid .empty-state')`, 'the every-column-hidden state')
steps.push({
  step: 'all hidden',
  message: await ev(`document.querySelector('.grid .empty-state__title').textContent.trim()`),
  picker: await picker()
})
check(steps.at(-1).message === 'Every column is hidden', 'an empty grid does not say why')
check(steps.at(-1).picker.count === '0 of 5 shown' && steps.at(-1).picker.buttons.includes('Hide all (off)'), 'the picker miscounts with every column hidden')
await press('Escape')
await waitFor(`!document.querySelector('.popover')`, 'the picker closing')
await shot('04-all-hidden')
await ev(`[...document.querySelectorAll('.grid .empty-state .btn')].find(b => b.textContent.trim() === 'Show all columns').click()`)
await waitFor(`document.querySelectorAll('.grid__th-name').length === 5`, 'every column back from the empty state')
check(!(await columnsButton()).armed, 'the button stayed lit with every column back')

// --- 8. Clear filters ------------------------------------------------------------
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.trim() === 'Refresh').click()`)
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('5 rows')`, 'the row written earlier')
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.trim() === 'Filter').click()`)
await waitFor(`!!document.querySelector('.filters__clear')`, 'the filter bar')
check(await ev(`document.querySelector('.filters__clear').disabled`), 'Clear filters is offered with nothing to clear')

const addFilter = async (column, value) => {
  await ev(`[...document.querySelectorAll('.filters__head .btn')].find(b => b.textContent.trim() === 'Add filter').click()`)
  await delay(100)
  await ev(`(() => {
    const row = [...document.querySelectorAll('.filters__row')].at(-1)
    const select = row.querySelector('.filters__column')
    select.value = '${column}'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await delay(100)
  await ev(`(() => {
    const input = [...document.querySelectorAll('.filters__row')].at(-1).querySelector('.filters__value')
    input.value = '${value}'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}
const applyFilters = () => ev(`[...document.querySelectorAll('.filters__head .btn')].find(b => b.textContent.trim() === 'Apply').click()`)

await addFilter('status', 'new')
await applyFilters()
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('3 rows')`, 'the filtered rows')
check(!(await ev(`document.querySelector('.filters__clear').disabled`)), 'Clear filters is not offered with a filter applied')
await shot('05-filtered')
await ev(`document.querySelector('.filters__clear').click()`)
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('5 rows')`, 'every row back')
steps.push({
  step: 'cleared',
  rows: await rowsLabel(),
  filterRows: await ev(`document.querySelectorAll('.filters__row').length`),
  clearDisabled: await ev(`document.querySelector('.filters__clear').disabled`),
  sql: await ev(`document.querySelector('.data__sql').textContent.trim()`)
})
check(steps.at(-1).filterRows === 0, 'Clear filters left a filter in the bar')
check(steps.at(-1).clearDisabled, 'Clear filters is still offered with nothing left to clear')
check(!steps.at(-1).sql.includes('WHERE'), 'the table was not read again unfiltered')

// A filter only drafted goes without a read: a row written now stays out.
check((await insert('six')).every((s) => s === 'ok'), 'could not insert')
await addFilter('name', 'two')
check(!(await ev(`document.querySelector('.filters__clear').disabled`)), 'Clear filters is not offered for a drafted filter')
await ev(`document.querySelector('.filters__clear').click()`)
await delay(800)
steps.push({ step: 'cleared a draft', rows: await rowsLabel(), filterRows: await ev(`document.querySelectorAll('.filters__row').length`) })
check(steps.at(-1).filterRows === 0, 'the drafted filter is still there')
check(steps.at(-1).rows === '5 rows', 'clearing a drafted filter read the table again')

// A raw WHERE clears the same way.
await ev(`[...document.querySelectorAll('.filters__mode')].find(b => b.textContent.trim() === 'Raw WHERE').click()`)
await ev(`(() => {
  const input = document.querySelector('.filters__raw input')
  input.value = "status = 'done'"
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await applyFilters()
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('2 rows')`, 'the raw filter applied')
await ev(`document.querySelector('.filters__clear').click()`)
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('6 rows')`, 'every row back from the raw filter')
check((await ev(`document.querySelector('.filters__raw input').value`)) === '', 'Clear filters left the raw WHERE')

// --- 9. a narrow pane keeps every button on the bar --------------------------------
const toolbar = () =>
  ev(`(() => {
    const bar = document.querySelector('.data__toolbar')
    const last = [...bar.querySelectorAll('.btn')].at(-1).getBoundingClientRect()
    return {
      overflow: bar.scrollWidth > bar.clientWidth,
      lastInside: last.right <= bar.getBoundingClientRect().right,
      labels: [...bar.querySelectorAll('.data__label')].filter(l => l.offsetParent).map(l => l.textContent.trim()),
      names: [...bar.querySelectorAll('.data__tool')].map(b => b.getAttribute('aria-label'))
    }
  })()`)
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.trim() === 'Add row').click()`)
await waitFor(`[...document.querySelectorAll('.data__toolbar .btn')].some(b => b.textContent.includes('Apply'))`, 'a staged row')
for (const width of [1280, 1100, 1000]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
  await delay(300)
  steps.push({ step: `narrow ${width}`, toolbar: await toolbar() })
  check(!steps.at(-1).toolbar.overflow && steps.at(-1).toolbar.lastInside, `the toolbar runs off a ${width}px window`)
  check(steps.at(-1).toolbar.names.every(Boolean), 'a button with no words has no name')
}
check(steps.at(-1).toolbar.labels.length === 0, 'the narrow bar kept the secondary labels')
await shot('06-narrow')
await send('Emulation.clearDeviceMetricsOverride')
await delay(300)
check((await toolbar()).labels.includes('Refresh'), 'the labels did not come back at full width')
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.trim() === 'Discard').click()`)

await runSql('DROP TABLE IF EXISTS dbo.e2e_tools')

const rendererErrors = logs.join('').split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif/i.test(l))
check(rendererErrors.length === 0, 'the renderer logged errors:\n' + rendererErrors.join('\n'))

console.log('TABLE TOOLS E2E PASS')
console.log(JSON.stringify(steps, null, 2))
child.kill('SIGKILL')
process.exit(0)
