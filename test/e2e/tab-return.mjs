/**
 * A tab comes back the way it was left.
 *
 * Only the tab on screen in a pane is mounted, so picking another one takes
 * its view down and everything the view was holding with it. This takes each
 * kind of tab away and back again and checks what it kept: a table's rows
 * scrolled down and across, over a column widened by hand; its structure
 * scrolled; a query's editor scrolled with a line selected, its results
 * scrolled on the result set that was showing, and a run's messages scrolled;
 * the activity monitor filtered and scrolled. And that coming back reads nothing again unless the tab
 * refreshes itself — a row written while a table was away stays out of it
 * until Refresh, unless its auto refresh is on, and a session opened while
 * the monitor was away is not in it until Refresh either.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9244
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-tab-return`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-tab-return`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('TAB RETURN E2E FAIL:', message)
  console.log(JSON.stringify(steps, null, 2))
  process.stdout.write(logs.join('').split('\n').slice(-30).join('\n'))
  child.kill('SIGKILL')
  process.exit(1)
}
function check(condition, message) {
  if (!condition) bail(message)
}
// The kinds of tab are independent of one another, so what each kept is
// checked and reported in full rather than stopping at the first that lost
// something.
const failures = []
function expect(condition, message, detail) {
  steps.push({ check: message, ok: Boolean(condition), ...(detail === undefined ? {} : { detail }) })
  if (!condition) failures.push(message)
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
const waitUntil = async (expr, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await ev(`(() => { try { return ${expr} } catch { return null } })()`)
    if (v) return v
    await delay(200)
  }
  return null
}
const waitFor = async (expr, label, ms = 30000) => (await waitUntil(expr, ms)) ?? bail('timed out waiting for ' + label)
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'))
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

const runSql = (sql, sessionId) =>
  ev(`(async () => {
    const [connection] = await window.api.listConnections()
    const result = await window.api.runQuery({
      connectionId: connection.id, sql: ${JSON.stringify(sql)}${sessionId ? `, sessionId: ${JSON.stringify(sessionId)}` : ''}
    })
    return result.statements.map((s) => s.error?.message ?? 'ok')
  })()`)

const COLUMNS = Array.from({ length: 16 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`)
check(
  (
    await runSql(`DROP TABLE IF EXISTS dbo.e2e_scroll;
GO
CREATE TABLE dbo.e2e_scroll (id int IDENTITY(1,1) PRIMARY KEY, ${COLUMNS.map((c) => `${c} nvarchar(80) NULL`).join(', ')});
GO
WITH n AS (SELECT TOP (400) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO dbo.e2e_scroll (${COLUMNS.join(', ')})
SELECT ${COLUMNS.map((c) => `CONCAT(N'row ', i, N' ${c} ', REPLICATE(N'x', 30))`).join(', ')} FROM n;`)
  ).every((s) => s === 'ok'),
  'could not create the table'
)

const rowsLabel = () => ev(`document.querySelector('.data__rows')?.textContent.trim()`)
const openTable = async (name) => {
  await ev(`[...document.querySelectorAll('.sidebar .item__name')].find(e => e.textContent.trim() === '${name}').closest('.item').click()`)
  await waitFor(`document.querySelector('.tab--active .tab__title')?.textContent.trim() === '${name}'`, `the ${name} tab`)
}
/** Picks a tab by its title, as a click on it in the strip does. */
const pick = async (title) => {
  await ev(`[...document.querySelectorAll('.tab')].find(t => t.querySelector('.tab__title')?.textContent.trim() === ${JSON.stringify(title)}).click()`)
  await waitFor(`document.querySelector('.tab--active .tab__title')?.textContent.trim() === ${JSON.stringify(title)}`, `the ${title} tab`)
}
const openMenu = async () => {
  if (!(await ev(`!!document.querySelector('.popover')`))) {
    await ev(`document.querySelector('.data__auto').click()`)
  }
  await waitFor(`!!document.querySelector('.popover [role=menuitemradio]')`, 'the interval menu')
}
const choose = async (ms) => {
  await openMenu()
  await ev(`document.querySelector('.popover [role=menuitemradio][data-value="${ms}"]').click()`)
  await waitFor(`!document.querySelector('.popover')`, 'the interval menu closing')
}

/**
 * Notes every read a view puts on screen from here on: the "Checking for
 * changes" a table shows while it re-reads behind its rows, and the spinner
 * the activity monitor shows while it reads. A read can be over in a few
 * milliseconds, so they are caught as they are added rather than looked for.
 */
const watchForReads = () =>
  ev(`(() => {
    window.__reads = []
    window.__readWatch?.disconnect()
    window.__readWatch = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        for (const selector of ['.data__refreshing', '.activity__spinner']) {
          if (node.matches(selector) || node.querySelector(selector)) window.__reads.push(selector)
        }
      }
    })
    window.__readWatch.observe(document.body, { childList: true, subtree: true })
    return true
  })()`)

/** Where a grid is scrolled to, both ways, and the widths its columns are drawn at. */
const gridState = (scope) =>
  ev(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)})
    const viewport = root?.querySelector('.grid__viewport')
    const header = root?.querySelector('.grid__header')
    if (!viewport || !header) return null
    return {
      top: viewport.scrollTop,
      left: viewport.scrollLeft,
      headerLeft: header.scrollLeft,
      columns: root.querySelector('.grid__header-track').style.gridTemplateColumns
    }
  })()`)
const scrollGrid = (scope, top, left) =>
  ev(`(() => {
    const viewport = document.querySelector(${JSON.stringify(`${scope} .grid__viewport`)})
    viewport.scrollTop = ${top}
    viewport.scrollLeft = ${left}
    return true
  })()`)

// --- 1. a table, scrolled down and across over a column widened by hand ---------
await ev(`document.querySelector('.sidebar__db-btn[title^="Refresh"]').click()`)
await waitFor(`[...document.querySelectorAll('.sidebar .item__name')].some(e => e.textContent.trim() === 'e2e_scroll')`, 'the table in the tree')
await openTable('e2e_scroll')
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('400 rows') && document.querySelectorAll('.data .grid__row').length > 0`, 'the rows')

// The first text column is widened by dragging its edge, with real input.
const edge = await ev(`(() => {
  const th = [...document.querySelectorAll('.data .grid__th')].find(th => th.querySelector('.grid__th-name')?.textContent.trim() === 'c01')
  const r = th.querySelector('.grid__resizer').getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`)
const columnsAsMeasured = (await gridState('.data')).columns
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edge.x, y: edge.y })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: edge.x, y: edge.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edge.x + 150, y: edge.y, button: 'left', buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: edge.x + 150, y: edge.y, button: 'left', clickCount: 1 })
await waitFor(`document.querySelector('.data .grid__header-track').style.gridTemplateColumns !== ${JSON.stringify(columnsAsMeasured)}`, 'the column to widen', 5000)

await scrollGrid('.data', 2400, 900)
await delay(300)
const tableLeft = await gridState('.data')
check(tableLeft.top === 2400 && tableLeft.left === 900 && tableLeft.headerLeft === 900, `the table did not scroll where it was told: ${JSON.stringify(tableLeft)}`)
steps.push({ step: 'table left', tableLeft })
await shot('01-table-left')

await pick('Query')
await waitFor(`!!document.querySelector('.cm-content')`, 'the query editor')
// Written while the table is away: a read on coming back would bring it in.
check((await runSql(`INSERT INTO dbo.e2e_scroll (c01) VALUES (N'written while away')`)).every((s) => s === 'ok'), 'could not write the row')
await watchForReads()
await pick('e2e_scroll')
await waitFor(`!!document.querySelector('.data .grid__viewport')`, 'the table again')
await delay(1500)
const tableBack = await gridState('.data')
steps.push({ step: 'table back', tableBack, reads: await ev('window.__reads'), rows: await rowsLabel() })
await shot('02-table-back')
expect(tableBack.top === tableLeft.top, 'the table came back scrolled to other rows', tableBack)
expect(
  tableBack.left === tableLeft.left && tableBack.headerLeft === tableLeft.left,
  'the table came back scrolled to other columns',
  tableBack
)
expect(tableBack.columns === tableLeft.columns, 'the widened column came back at another width', {
  left: tableLeft.columns,
  back: tableBack.columns
})
expect(!(await ev('window.__reads')).includes('.data__refreshing'), 'the table was read again on coming back, with auto refresh off')
expect((await rowsLabel()) === '400 rows', 'a row written while the table was away turned up without a Refresh', await rowsLabel())

// The row was there to be read all along: Refresh brings it.
await ev(`document.querySelector('.data__toolbar .btn[aria-label="Refresh"]').click()`)
await waitFor(`document.querySelector('.data__rows')?.textContent.includes('401 rows')`, 'the row, once Refresh asks for it', 10000)

// --- 2. a table that refreshes itself is read on coming back ----------------------
// Every 15 minutes: no tick of its own falls inside this step, so only coming
// back can bring the row in.
await choose(900000)
await delay(500)
await pick('Query')
check((await runSql(`INSERT INTO dbo.e2e_scroll (c01) VALUES (N'written while away again')`)).every((s) => s === 'ok'), 'could not write the second row')
await pick('e2e_scroll')
expect(
  await waitUntil(`document.querySelector('.data__rows')?.textContent.includes('402 rows')`, 8000),
  'a table refreshing itself was not read again on coming back',
  await rowsLabel()
)
const tableReread = await gridState('.data')
expect(
  tableReread.top === tableLeft.top && tableReread.left === tableLeft.left,
  'reading the table again on coming back moved it',
  tableReread
)
await choose(0)

// --- 3. its structure, scrolled ---------------------------------------------------
await ev(`[...document.querySelectorAll('.data__toolbar .seg__opt')].find(b => b.textContent.includes('Structure')).click()`)
await waitFor(`!!document.querySelector('.structure__scroll')`, 'the structure')
check(
  await ev(`(() => { const s = document.querySelector('.structure__scroll'); return s.scrollHeight - s.clientHeight > 300 })()`),
  'the structure is too short to scroll'
)
await ev(`document.querySelector('.structure__scroll').scrollTop = 300`)
await delay(200)
await pick('Query')
await pick('e2e_scroll')
await waitFor(`!!document.querySelector('.structure__scroll')`, 'the structure again')
expect(
  await waitUntil(`document.querySelector('.structure__scroll')?.scrollTop === 300`, 5000),
  'the structure came back scrolled to the top',
  await ev(`document.querySelector('.structure__scroll')?.scrollTop`)
)
await ev(`[...document.querySelectorAll('.structure__toolbar .seg__opt')].find(b => b.textContent.includes('Data')).click()`)
await waitFor(`!!document.querySelector('.data .grid__viewport')`, 'the rows again')

// --- 4. a query: the editor scrolled with a line selected, the results scrolled ---
await pick('Query')
await waitFor(`!!document.querySelector('.cm-content')`, 'the query editor')
// The editor's view, as `EditorView.findFromDOM` finds it from the content element.
const CM = `document.querySelector('.cm-content').cmTile.root.view`
const script = [
  ...Array.from({ length: 150 }, (_, i) => `-- line ${i + 1}`),
  'SELECT * FROM dbo.e2e_scroll ORDER BY id;',
  `SELECT id, ${[...COLUMNS].reverse().join(', ')} FROM dbo.e2e_scroll ORDER BY id DESC;`
].join('\n')
await ev(`(() => { const view = ${CM}; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(script)} } }); return true })()`)
await ev(`document.querySelector('.query__toolbar .btn--primary').click()`)
await waitFor(`[...document.querySelectorAll('.results__tab')].some(t => t.textContent.trim().startsWith('Result 2'))`, 'both result sets', 20000)
await ev(`[...document.querySelectorAll('.results__tab')].find(t => t.textContent.trim().startsWith('Result 2')).click()`)
await waitFor(`document.querySelector('.results__tab--active')?.textContent.trim().startsWith('Result 2')`, 'the second result set')
await scrollGrid('.query__results', 1500, 600)
const editorState = () =>
  ev(`(() => {
    const view = ${CM}
    const { anchor, head } = view.state.selection.main
    return { anchor, head, top: view.scrollDOM.scrollTop }
  })()`)
await ev(`(() => {
  const view = ${CM}
  const line = view.state.doc.line(40)
  view.dispatch({ selection: { anchor: line.from, head: line.to } })
  view.scrollDOM.scrollTop = 1000
  return true
})()`)
await delay(300)
const editorLeft = await editorState()
const resultsLeft = await gridState('.query__results')
check(editorLeft.top === 1000 && editorLeft.head > editorLeft.anchor, `the editor did not take the selection and scroll: ${JSON.stringify(editorLeft)}`)
check(resultsLeft.top === 1500 && resultsLeft.left === 600, `the results did not scroll where they were told: ${JSON.stringify(resultsLeft)}`)
steps.push({ step: 'query left', editorLeft, resultsLeft })
await shot('03-query-left')

await pick('e2e_scroll')
await pick('Query')
await waitFor(`!!document.querySelector('.cm-content') && !!document.querySelector('.query__results .results__tab')`, 'the query again')
await delay(500)
const editorBack = await editorState()
const resultsBack = await gridState('.query__results')
const resultTab = await ev(`document.querySelector('.results__tab--active')?.textContent.trim()`)
steps.push({ step: 'query back', editorBack, resultsBack, resultTab })
await shot('04-query-back')
expect(Math.abs(editorBack.top - editorLeft.top) <= 1, 'the editor came back scrolled somewhere else', editorBack)
expect(
  editorBack.anchor === editorLeft.anchor && editorBack.head === editorLeft.head,
  'the editor came back without its selection',
  editorBack
)
expect(resultTab?.startsWith('Result 2'), 'the results came back on another result set', resultTab)
expect(
  resultsBack?.top === resultsLeft.top && resultsBack?.left === resultsLeft.left && resultsBack?.headerLeft === resultsLeft.left,
  'the results came back scrolled somewhere else',
  resultsBack
)

// The messages too: a run with nothing but messages, read down the list.
await ev(`(() => { const view = ${CM}; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "DECLARE @i int = 1; WHILE @i <= 120 BEGIN PRINT CONCAT(N'message ', @i); SET @i += 1 END" } }); return true })()`)
await ev(`document.querySelector('.query__toolbar .btn--primary').click()`)
await waitFor(`[...document.querySelectorAll('.results__tab')].some(t => t.textContent.trim().startsWith('Messages') && t.textContent.includes('120'))`, 'the messages', 20000)
await ev(`[...document.querySelectorAll('.results__tab')].find(t => t.textContent.trim().startsWith('Messages')).click()`)
await waitFor(`!!document.querySelector('.messages')`, 'the messages list')
check(
  await ev(`(() => { const list = document.querySelector('.messages'); return list.scrollHeight - list.clientHeight > 400 })()`),
  'the messages are too few to scroll'
)
await ev(`document.querySelector('.messages').scrollTop = 400`)
await delay(200)
await pick('e2e_scroll')
await pick('Query')
await waitFor(`!!document.querySelector('.query__results .results__tab')`, 'the query again')
await delay(300)
const messagesBack = {
  tab: await ev(`document.querySelector('.results__tab--active')?.textContent.trim()`),
  top: await ev(`document.querySelector('.messages')?.scrollTop`)
}
steps.push({ step: 'messages back', messagesBack })
expect(
  messagesBack.tab?.startsWith('Messages') && messagesBack.top === 400,
  'the messages came back scrolled to the top, or not at all',
  messagesBack
)

// --- 5. the activity monitor: filtered, scrolled, and not read again -------------
// Sessions enough to scroll through, each having run something the filter can
// find them by.
for (let i = 1; i <= 40; i += 1) {
  check((await runSql(`SELECT N'e2e filler ${i}'`, `e2e-filler-${i}`)).every((s) => s === 'ok'), 'could not open the filler sessions')
}
await ev(`[...document.querySelectorAll('.titlebar__menu')].find(b => b.textContent.trim() === 'View').click()`)
await waitFor(`!!document.querySelector('.titlebar__dropdown')`, 'the View menu')
await ev(`[...document.querySelectorAll('.titlebar__dropdown .titlebar__item')].find(i => i.textContent.includes('Activity Monitor')).click()`)
await waitFor(`!!document.querySelector('.activity .sessions tbody tr[data-session]')`, 'the sessions')
// Sleeping sessions too: the fillers have finished what they ran.
await ev(`[...document.querySelectorAll('.activity__toolbar .btn')].find(b => b.textContent.includes('Idle sessions')).click()`)
await waitFor(`document.querySelectorAll('.activity .sessions tr[data-session]').length >= 40`, 'the idle sessions listed')
await ev(`(() => {
  const input = document.querySelector('.activity__filter-input')
  input.value = 'e2e filler'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await waitFor(`document.querySelectorAll('.activity .sessions tr[data-session]').length === 40`, 'the fillers, filtered')
const listed = () => ev(`[...document.querySelectorAll('.activity .sessions tr[data-session]')].map(r => r.dataset.session).join(',')`)
check(
  await ev(`(() => { const body = document.querySelector('.activity__body'); return body.scrollHeight - body.clientHeight > 200 })()`),
  'the sessions are too few to scroll'
)
await ev(`document.querySelector('.activity__body').scrollTop = 200`)
await delay(200)
const activityLeft = {
  sessions: await listed(),
  top: await ev(`document.querySelector('.activity__body').scrollTop`)
}
steps.push({ step: 'activity left', activityLeft })

await pick('Query')
const newcomer = await ev(`(async () => {
  const [connection] = await window.api.listConnections()
  const result = await window.api.runQuery({ connectionId: connection.id, sql: "SELECT @@SPID AS spid, N'e2e filler newcomer' AS note", sessionId: 'e2e-newcomer' })
  return String(result.statements[0].resultSets[0].rows[0][0])
})()`)
await watchForReads()
await pick('Activity')
await waitFor(`!!document.querySelector('.activity .sessions')`, 'the activity monitor again')
await delay(1500)
const activityBack = {
  sessions: await listed(),
  top: await ev(`document.querySelector('.activity__body').scrollTop`),
  filter: await ev(`document.querySelector('.activity__filter-input').value`),
  reads: await ev('window.__reads')
}
steps.push({ step: 'activity back', newcomer, activityBack })
await shot('05-activity-back')
expect(activityBack.filter === 'e2e filler', 'the activity monitor came back without its filter', activityBack.filter)
expect(activityBack.top === activityLeft.top, 'the activity monitor came back scrolled somewhere else', activityBack.top)
expect(
  activityBack.sessions === activityLeft.sessions && !activityBack.reads.includes('.activity__spinner'),
  'the activity monitor read the server again on coming back, with auto refresh off',
  activityBack
)
await ev(`[...document.querySelectorAll('.activity__toolbar .btn')].find(b => b.textContent.trim() === 'Refresh').click()`)
expect(
  await waitUntil(`!!document.querySelector('.activity .sessions tr[data-session="${newcomer}"]')`, 10000),
  'Refresh did not list the session opened while the monitor was away'
)

await runSql('DROP TABLE IF EXISTS dbo.e2e_scroll')

const rendererErrors = logs.join('').split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif/i.test(l))
expect(rendererErrors.length === 0, 'the renderer logged errors', rendererErrors)

if (failures.length > 0) {
  console.log(`TAB RETURN E2E FAIL: ${failures.length} of the checks failed`)
  for (const failure of failures) console.log(' -', failure)
  console.log(JSON.stringify(steps, null, 2))
  child.kill('SIGKILL')
  process.exit(1)
}
console.log('TAB RETURN E2E PASS')
console.log(JSON.stringify(steps, null, 2))
child.kill('SIGKILL')
process.exit(0)
