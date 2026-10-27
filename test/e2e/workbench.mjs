/**
 * Drives the workbench's own tools through the real app: quick open
 * (Ctrl+P), the figures for the selected rows, the activity monitor — a
 * transaction left open blocking a read, seen as a chain and killed — and
 * the call a long query's desktop notification goes through.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9240
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-workbench`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-workbench`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('WORKBENCH E2E FAIL:', message)
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
const KEY_CODES = { Escape: 27, ArrowRight: 39, ArrowDown: 40, Enter: 13, F5: 116, c: 67, l: 76, m: 77, p: 80, t: 84, v: 86 }
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

const runSql = (sql, sessionId) =>
  ev(`(async () => {
    const [connection] = await window.api.listConnections()
    const result = await window.api.runQuery({
      connectionId: connection.id, sql: ${JSON.stringify(sql)}, sessionId: ${JSON.stringify(sessionId ?? null)} || undefined
    })
    return result.statements.map((s) => s.error?.message ?? 'ok')
  })()`)

await ev(`[...document.querySelectorAll('.row__buttons .btn')].find(b=>b.textContent.includes('Connect')).click()`)
await waitFor(`!!document.querySelector('.workspace')`, 'workspace', 45000)
await waitFor(`document.querySelectorAll('.sidebar .item').length > 0`, 'sidebar')

check(
  (
    await runSql(`DROP TABLE IF EXISTS dbo.e2e_figures;
GO
CREATE TABLE dbo.e2e_figures (
  id int PRIMARY KEY,
  label nvarchar(20) NULL,
  amount decimal(10, 2) NULL,
  big bigint NULL
);
GO
INSERT INTO dbo.e2e_figures VALUES
  (1, N'a', 0.10, 9007199254740993),
  (2, N'b', 0.20, 9007199254740993),
  (3, N'a', NULL, 1),
  (4, N'c', 1200.00, 2);`)
  ).every((s) => s === 'ok'),
  'could not create the table'
)
// The tree was read before the table existed.
await ev(`document.querySelector('.sidebar__db-btn[aria-label="Refresh"]').click()`)
await waitFor(
  `[...document.querySelectorAll('.sidebar .item__name')].some(e => e.textContent.trim() === 'e2e_figures')`,
  'the new table in the tree'
)

// --- 1. quick open ------------------------------------------------------------
await press('p', 2)
await waitFor(`!!document.querySelector('.quick__input')`, 'the quick open box')
check(await ev(`document.activeElement === document.querySelector('.quick__input')`), 'quick open did not take the focus')
await send('Input.insertText', { text: 'e2efig' })
await waitFor(`document.querySelector('.quick__item .quick__name')?.textContent.trim() === 'e2e_figures'`, 'e2e_figures first')
steps.push({
  step: 'quick open',
  listed: await ev(`[...document.querySelectorAll('.quick__item')].slice(0, 3).map(i => i.textContent.replace(/\\s+/g, ' ').trim())`),
  hits: await ev(`[...document.querySelectorAll('.quick__item')][0].querySelectorAll('.quick__hit').length`)
})
await delay(400)
await shot('01-quick-open')
await press('Enter')
await waitFor(`!document.querySelector('.quick__input')`, 'quick open to close')
await waitFor(`document.querySelector('.data__name')?.textContent.includes('e2e_figures')`, 'the table opened from quick open')
await waitFor(`document.querySelectorAll('.grid__row').length === 4`, 'its rows')

// Escape closes it without opening anything.
await press('p', 2)
await waitFor(`!!document.querySelector('.quick__input')`, 'the quick open box, again')
await press('Escape')
await waitFor(`!document.querySelector('.quick__input')`, 'Escape to close quick open')

// Shift+Enter opens a table's structure.
await press('p', 2)
await waitFor(`!!document.querySelector('.quick__input')`, 'the quick open box, a third time')
check(
  await ev(`document.querySelector('.quick__item .quick__name')?.textContent.trim() === 'e2e_figures'`),
  'the table just opened was not offered first'
)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 })
await waitFor(`!!document.querySelector('.structure') && !document.querySelector('.grid__row')`, 'the structure view')
await waitFor(`[...document.querySelectorAll('.seg--caps .seg__opt')].some(b => b.textContent.trim() === 'Data')`, 'the view switch')
await ev(`[...document.querySelectorAll('.seg--caps .seg__opt')].find(b => b.textContent.trim() === 'Data').click()`)
await waitFor(`document.querySelectorAll('.grid__row').length === 4`, 'the rows again')

// --- 2. figures for the selected rows ------------------------------------------
const columnIndex = async (name) =>
  ev(`[...document.querySelectorAll('.grid__th-name')].findIndex(e => e.textContent.trim() === '${name}')`)
const clickCell = (row, col, shift = false) =>
  ev(`(() => {
    const cell = document.querySelectorAll('.grid__row')[${row}].querySelectorAll('.grid__cell')[${col}]
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, shiftKey: ${shift} }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  })()`)
// Read as the parts it shows, label and value, the way the eye reads the gaps.
const figuresIn = (selector) =>
  ev(`(() => {
    const root = document.querySelector('${selector}')
    if (!root) return null
    const parts = [...root.querySelectorAll('.figures__part')].map(p => p.querySelector('.figures__label').textContent.trim() + ' ' + p.querySelector('.figures__value').textContent.trim())
    return [root.querySelector('.figures__column').textContent.trim(), root.querySelector('.figures__rows').textContent.replace(/\\s+/g, ' ').trim(), ...parts].join(' · ')
  })()`)
const figures = () => figuresIn('.data__figures')

const amount = await columnIndex('amount')
await clickCell(0, amount)
check((await figures()) === null, 'one row selected showed figures')
await clickCell(3, amount, true)
await waitFor(`!!document.querySelector('.data__figures')`, 'the figures')
steps.push({ step: 'figures over amount', text: await figures() })
check(steps.at(-1).text.includes('Sum 1,200.30'), 'the sum of the amounts is wrong')
check(steps.at(-1).text.includes('Avg 400.10'), 'the average of the amounts is wrong')
check(steps.at(-1).text.includes('NULL 1'), 'the NULL was not counted apart')
check(steps.at(-1).text.includes('this page'), 'the figures did not say they cover this page')
await shot('02-figures')

await clickCell(0, await columnIndex('big'))
await clickCell(1, await columnIndex('big'), true)
steps.push({ step: 'figures over big', text: await figures() })
check(steps.at(-1).text.includes('Sum 18,014,398,509,481,986'), 'the bigint sum lost precision')

await clickCell(0, await columnIndex('label'))
await clickCell(3, await columnIndex('label'), true)
steps.push({ step: 'figures over label', text: await figures() })
check(steps.at(-1).text.includes('Distinct 3') && !steps.at(-1).text.includes('Sum'), 'text figures are wrong')

// The same in a query's results.
await ev(`document.querySelector('.tabbar__new').click()`)
await waitFor(`!!document.querySelector('.cm-content')`, 'a query editor')
await ev(`document.querySelector('.cm-content').focus()`)
await send('Input.insertText', { text: 'SELECT amount FROM dbo.e2e_figures ORDER BY id' })
await press('Enter', 2)
await waitFor(`document.querySelectorAll('.results .grid__row').length === 4`, 'the query results')
await ev(`(() => {
  const rows = document.querySelectorAll('.results .grid__row')
  rows[0].querySelectorAll('.grid__cell')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  rows[1].querySelectorAll('.grid__cell')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, shiftKey: true }))
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  return true
})()`)
await waitFor(`!!document.querySelector('.results__figures')`, 'the figures in the results bar')
steps.push({ step: 'figures in results', text: await figuresIn('.results__figures') })
check(steps.at(-1).text.includes('Sum 0.30'), 'the results figures are wrong')
await shot('03-results-figures')

// --- 3. the activity monitor -----------------------------------------------------
check(
  (await runSql("BEGIN TRAN; UPDATE dbo.e2e_figures SET label = N'held' WHERE id = 1;", 'e2e-holder')).every((s) => s === 'ok'),
  'could not open the holding transaction'
)
await ev(`(async () => {
  const [connection] = await window.api.listConnections()
  window.__waiting = window.api.runQuery({
    connectionId: connection.id, sql: 'SELECT label FROM dbo.e2e_figures WHERE id = 1', sessionId: 'e2e-waiter'
  })
  return true
})()`)

await ev(`[...document.querySelectorAll('.titlebar__menu')].find(b => b.textContent.trim() === 'View').click()`)
await waitFor(`!!document.querySelector('.titlebar__dropdown')`, 'the View menu')
await ev(`[...document.querySelectorAll('.titlebar__dropdown .titlebar__item')].find(i => i.textContent.includes('Activity Monitor')).click()`)
await waitFor(`!!document.querySelector('.activity .sessions tbody tr[data-session]')`, 'the sessions')
// The waiting read opens a session of its own first, so it may not be blocked
// yet when the monitor first reads; Refresh until it is.
for (let tries = 0; tries < 20 && !(await ev(`!!document.querySelector('.chain')`)); tries += 1) {
  await delay(500)
  await ev(`[...document.querySelectorAll('.activity__toolbar .btn')].find(b => b.textContent.trim() === 'Refresh').click()`)
}
await waitFor(`!!document.querySelector('.chain')`, 'a blocking chain', 5000)
steps.push({
  step: 'activity',
  counts: await ev(`document.querySelector('.activity__counts').textContent.replace(/\\s+/g, ' ').trim()`),
  chain: await ev(`[...document.querySelectorAll('.chain__link')].map(l => l.textContent.replace(/\\s+/g, ' ').trim())`),
  badges: await ev(`[...document.querySelectorAll('.sessions .badge')].map(b => b.textContent.trim())`),
  tabTitle: await ev(`document.querySelector('.tab--active')?.textContent.trim()`)
})
check(steps.at(-1).chain.length === 2 && steps.at(-1).chain[0].includes('head blocker'), 'the chain is not head then blocked')
check(steps.at(-1).badges.includes('monitor'), "the monitor's own session is not marked")
await shot('04-activity')

// Kill the head blocker, through the question.
await ev(`document.querySelector('.chain__link--head').click()`)
await waitFor(`!!document.querySelector('.detail')`, 'the session details')
await ev(`[...document.querySelectorAll('.detail .btn')].find(b => b.textContent.trim() === 'Kill').click()`)
await waitFor(`!!document.querySelector('.modal')`, 'the kill question')
steps.push({ step: 'kill question', text: await ev(`document.querySelector('.modal').textContent.replace(/\\s+/g, ' ').trim()`) })
await shot('05-kill-question')
await ev(`[...document.querySelectorAll('.modal__foot .btn')].find(b => b.textContent.trim() === 'Kill').click()`)
await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('was killed'))`, 'the kill toast')
const waited = await ev(`window.__waiting.then(r => r.statements.map(s => s.error?.message ?? s.resultSets[0].rows))`)
steps.push({ step: 'the read went on', waited })
check(JSON.stringify(waited) === JSON.stringify([[['a']]]), 'the blocked read did not finish with the rolled-back value')
await waitFor(`!document.querySelector('.chain')`, 'the chain to go')

// --- 4. importing a CSV file, dropped on the rows ---------------------------------
await ev(`[...document.querySelectorAll('.tab')].find(t => t.textContent.includes('e2e_figures')).click()`)
await waitFor(`document.querySelectorAll('.grid__row').length === 4`, 'the table again')
await ev(`(() => {
  const csv = 'Id,Label,Amount\\r\\n10,ten,10.50\\r\\n11,eleven,abc\\r\\n12,,\\r\\n13,thirteen,13\\r\\n'
  const transfer = new DataTransfer()
  transfer.items.add(new File([csv], 'people.csv', { type: 'text/csv' }))
  const target = document.querySelector('.data__grid')
  target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  return true
})()`)
await waitFor(`!!document.querySelector('.import')`, 'the import dialog')
await delay(400)
steps.push({
  step: 'import dialog',
  title: await ev(`document.querySelector('.modal__title').textContent.trim()`),
  subtitle: await ev(`document.querySelector('.modal__subtitle').textContent.trim()`),
  mapping: await ev(`[...document.querySelectorAll('.mapping tr')].map(r => r.querySelector('.mapping__name').textContent.trim() + ' <- ' + r.querySelector('select').selectedOptions[0].textContent.trim())`),
  problems: await ev(`[...document.querySelectorAll('.problems li')].map(l => l.textContent.replace(/\\s+/g, ' ').trim())`),
  stage: await ev(`[...document.querySelectorAll('.modal__foot .btn')].at(-1).textContent.trim()`)
})
await shot('06-import')
check(steps.at(-1).mapping.join('|') === 'id <- 1. Id|label <- 2. Label|amount <- 3. Amount|big <- — leave out —', 'the columns were not matched by name')
check(steps.at(-1).problems.length === 1 && steps.at(-1).problems[0].includes('Line 3'), 'the bad amount was not reported on line 3')
check(steps.at(-1).stage === 'Stage 3 rows, leave out 1', 'the stage button does not say what it stages')
await ev(`[...document.querySelectorAll('.modal__foot .btn')].at(-1).click()`)
await waitFor(`document.querySelectorAll('.grid__row').length === 7`, 'the staged rows in the grid')
check(
  await ev(`[...document.querySelectorAll('.data__toolbar .btn')].some(b => b.textContent.replace(/\\s+/g, '') === 'Apply3')`),
  'Apply does not count the three staged rows'
)
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.includes('Apply')).click()`)
await waitFor(`!!document.querySelector('.statement__sql')`, 'the review before Apply')
steps.push({ step: 'review', statements: await ev(`[...document.querySelectorAll('.statement__sql')].map(e => e.textContent.trim())`) })
check(steps.at(-1).statements.length === 1 && steps.at(-1).statements[0].includes('(12, NULL, NULL)'), 'the three rows are not one multi-row insert')
// Highlighted as the editor would: keywords and strings in their own colours.
const colours = await ev(`(() => {
  const sql = document.querySelector('.statement__sql')
  const colourOf = (text) => {
    const span = [...sql.querySelectorAll('span')].find(s => s.textContent.trim() === text)
    return span ? getComputedStyle(span).color : null
  }
  return { keyword: colourOf('INSERT'), string: colourOf("'ten'"), number: colourOf('12'), plain: getComputedStyle(sql).color }
})()`)
steps.push({ step: 'review highlighting', colours })
check(colours.keyword && colours.string && colours.keyword !== colours.string && colours.keyword !== colours.plain, 'the statement is not highlighted')
await delay(500)
await shot('06b-review-highlighted')
await ev(`[...document.querySelectorAll('.modal__foot .btn')].find(b => b.textContent.trim() === 'Apply').click()`)
await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('3 inserted'))`, 'the apply toast')
await waitFor(`document.querySelectorAll('.grid__row').length === 7 && !document.querySelector('.grid__row--inserted')`, 'the applied rows read back')

// --- 5. pasting a range from a spreadsheet ---------------------------------------------
const labelCol = await columnIndex('label')
await clickCell(0, labelCol)
await ev(`document.querySelector('.grid__viewport').focus()`)
await ev(`window.api.copyToClipboard('label\\tamount\\nP1\\t1.25\\nP2\\t2.50\\n')`)
await press('v', 2)
await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Pasted: 2 rows changed'))`, 'the paste over two rows')
const cellText = (row, col) => ev(`document.querySelectorAll('.grid__row')[${row}].querySelectorAll('.grid__cell')[${col}].textContent.trim()`)
steps.push({ step: 'paste over rows', first: await cellText(0, labelCol), second: await cellText(1, amount) })
check(steps.at(-1).first === 'P1' && steps.at(-1).second === '2.5', 'the pasted values are not in the cells')

// Past the last row, the rest become new rows.
await clickCell(6, labelCol)
await ev(`document.querySelector('.grid__viewport').focus()`)
await ev(`window.api.copyToClipboard('Q1\\nQ2\\nQ3')`)
await press('v', 2)
await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('1 row changed, 2 rows added'))`, 'the paste past the end')
check((await ev(`document.querySelectorAll('.grid__row').length`)) === 9, 'the pasted rows were not added')
await shot('07-pasted')
await ev(`[...document.querySelectorAll('.data__toolbar .btn')].find(b => b.textContent.trim() === 'Discard').click()`)
await waitFor(`document.querySelectorAll('.grid__row').length === 7`, 'the paste discarded')

// --- 6. execution plans -------------------------------------------------------------
await ev(`document.querySelector('.tabbar__new').click()`)
await waitFor(`document.querySelectorAll('.cm-content').length > 0 && document.querySelector('.tab--active')?.textContent.includes('Query')`, 'a new query tab')
await ev(`document.querySelector('.cm-content').focus()`)
await send('Input.insertText', { text: "SELECT label, SUM(amount) FROM dbo.e2e_figures WHERE label = N'a' GROUP BY label" })
await press('l', 2)
await waitFor(`!!document.querySelector('.plan .ops__row')`, 'the estimated plan', 20000)
steps.push({
  step: 'estimated plan',
  heading: await ev(`document.querySelector('.plan__doc-head .caps').textContent.trim()`),
  operators: await ev(`[...document.querySelectorAll('.plan .ops__row')].map(r => r.dataset.op)`),
  columns: await ev(`[...document.querySelectorAll('.plan .ops th')].map(t => t.textContent.trim())`),
  warnings: await ev(`[...document.querySelectorAll('.stmt__warnings li')].map(l => l.textContent.trim())`),
  planTab: await ev(`document.querySelector('.results__tab--active')?.textContent.trim()`)
})
check(steps.at(-1).heading === 'Estimated plan', 'the plan does not say it is estimated')
check(steps.at(-1).columns.join('|') === 'Operator|Cost|Est. rows', 'an estimated plan shows actual columns')
check(steps.at(-1).planTab === 'Plan', 'the results did not open on the plan')
await ev(`document.querySelectorAll('.toast button[aria-label="Dismiss"]').forEach(b => b.click())`)
await delay(300)
await shot('08-estimated-plan')

await ev(`document.querySelector('.cm-content').focus()`)
await press('m', 2)
await waitFor(`document.querySelector('.plan__doc-head .caps')?.textContent.trim() === 'Actual plan'`, 'the actual plan', 20000)
steps.push({
  step: 'actual plan',
  columns: await ev(`[...document.querySelectorAll('.plan .ops th')].map(t => t.textContent.trim())`),
  actualRows: await ev(`[...document.querySelectorAll('.plan .ops__row')].map(r => r.children[3]?.textContent.trim())`),
  resultTabs: await ev(`[...document.querySelectorAll('.results__tab')].map(t => t.textContent.replace(/\\s+/g, ' ').trim())`)
})
check(steps.at(-1).columns.includes('Actual rows'), 'the actual plan has no actual rows')
check(steps.at(-1).resultTabs.some((t) => t.startsWith('Result 1')), 'the query rows did not come back beside the plan')
await ev(`document.querySelectorAll('.toast button[aria-label="Dismiss"]').forEach(b => b.click())`)
await delay(300)
await shot('09-actual-plan')
// The session is not left compiling only: a plain run returns rows and no plan.
await press('Enter', 2)
await waitFor(`!document.querySelector('.plan') && [...document.querySelectorAll('.results__tab')].every(t => !t.textContent.includes('Plan'))`, 'a plain run after the plans')

// --- 7. a notification goes quietly where there is no daemon -----------------------
steps.push({
  step: 'notify',
  result: await ev(`window.api.notifyQueryFinished({ title: 'Q finished', body: 'Finished in 12 s', tabId: 'none' }).then(() => 'ok', (e) => e.message)`)
})
check(steps.at(-1).result === 'ok', 'the notification call failed')

await runSql('DROP TABLE IF EXISTS dbo.e2e_figures')

const rendererErrors = logs.join('').split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif/i.test(l))
check(rendererErrors.length === 0, 'the renderer logged errors:\n' + rendererErrors.join('\n'))

console.log('WORKBENCH E2E PASS')
console.log(JSON.stringify(steps, null, 2))
child.kill('SIGKILL')
process.exit(0)
