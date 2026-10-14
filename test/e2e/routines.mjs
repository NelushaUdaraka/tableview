/**
 * Drives a routine's definition through the real app: the marks beside the
 * editor's line numbers, the peek that shows what a change replaced,
 * reverting one change while the others stay, taking that back with Ctrl+Z,
 * stepping between changes, reverting the lot, and saving — after which what
 * was run is what the marks compare against.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 9229
const SHOTS = process.argv[2] ?? `${PROJECT}/.tmp/e2e-routines`
mkdirSync(SHOTS, { recursive: true })

const logs = []
const child = spawn(
  `${PROJECT}/node_modules/.bin/electron`,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${PROJECT}/.tmp/profile-routines`],
  { cwd: PROJECT, env: { ...process.env, DISPLAY: ':99', ELECTRON_ENABLE_LOGGING: '1' } }
)
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

const steps = []
function bail(message) {
  console.log('ROUTINES E2E FAIL:', message)
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

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const key = async (keyName, code, keyCode, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key: keyName, code, windowsVirtualKeyCode: keyCode })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: keyName, code, windowsVirtualKeyCode: keyCode })
}
/** Puts the cursor at the end of a 1-based line of the editor. */
const toLineEnd = async (line) => {
  await ev(`document.querySelector('.cm-content').focus()`)
  await key('Home', 'Home', 36, 2)
  for (let i = 1; i < line; i += 1) await key('ArrowDown', 'ArrowDown', 40)
  await key('End', 'End', 35)
}
const click = async (selectorExpr) => {
  const box = await ev(`(() => { const r = (${selectorExpr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
}
const editorLines = () => ev(`[...document.querySelectorAll('.cm-content .cm-line')].map(l => l.textContent)`)
const changesLabel = () => ev(`document.querySelector('.query__changes')?.textContent.trim().replace(/\\s+/g, ' ')`)
const marks = () => ev(`[...document.querySelectorAll('.cm-changeMark')].map(m => m.className.replace('cm-changeMark cm-changeMark--', ''))`)

await send('Runtime.enable'); await send('Page.enable')
await waitFor(`!!document.querySelector('.titlebar')`, 'title bar')

// Seed a connection and reload so the UI picks it up.
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

const ROUTINE = [
  'CREATE OR ALTER PROCEDURE dbo.usp_e2e_orders',
  '  @status varchar(20)',
  'AS',
  'BEGIN',
  '  SET NOCOUNT ON;',
  '  SELECT order_id, customer_id',
  '  FROM sales.orders',
  '  WHERE status = @status',
  '  ORDER BY order_id;',
  'END'
].join('\n')

const runSql = (sql) =>
  ev(`(async () => {
    const [connection] = await window.api.listConnections()
    const result = await window.api.runQuery({ connectionId: connection.id, sql: ${JSON.stringify(sql)} })
    return result.statements.map((s) => s.error?.message ?? 'ok')
  })()`)

check((await runSql(ROUTINE)).every((s) => s === 'ok'), 'could not create the procedure')

// --- 1. opening the routine from the tree -----------------------------------
await ev(`document.querySelector('.sidebar__db-btn[title^="Refresh"]').click()`)
const routineItem = `[...document.querySelectorAll('.sidebar .item__name')].find(e => e.textContent.trim() === 'usp_e2e_orders')?.closest('.item')`
await waitFor(`!!${routineItem}`, 'the procedure in the tree')
const openRoutine = () =>
  ev(`(() => { const item = ${routineItem}; item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); item.click(); return true })()`)
await openRoutine()
await waitFor(`document.querySelector('.cm-content')?.textContent.includes('usp_e2e_orders')`, 'the definition')
await waitFor(`!!document.querySelector('.query__changes')`, 'the change count')

const opened = await editorLines()
steps.push({
  step: 'opened',
  tab: await ev(`document.querySelector('.tab--active .tab__title').textContent.trim()`),
  icon: await ev(`document.querySelector('.tab--active .tab__icon').textContent.trim()`),
  firstLine: opened[0],
  label: await changesLabel(),
  gutter: await ev(`!!document.querySelector('.cm-changeGutter')`),
  marked: await ev(`!!document.querySelector('.sidebar .item--active .item__name')?.textContent.includes('usp_e2e_orders')`)
})
check(steps.at(-1).tab === 'usp_e2e_orders', 'tab is not titled by the routine')
check(steps.at(-1).label === 'No changes', 'a freshly opened routine reports changes')
check(steps.at(-1).gutter, 'no change gutter on a routine tab')
check(steps.at(-1).marked, 'the tree does not mark the open routine')
// SQL Server keeps `CREATE   PROCEDURE` of what it was sent; the gap reads back as one space.
check(opened[0] === 'CREATE OR ALTER PROCEDURE dbo.usp_e2e_orders', 'not opened as CREATE OR ALTER')

// --- 2. three separate edits ------------------------------------------------
await toLineEnd(6)
await send('Input.insertText', { text: ', total' }) // modified
await toLineEnd(7)
await send('Input.insertText', { text: '\n  -- only the ones asked for' }) // added
await toLineEnd(10) // "  ORDER BY order_id;" — deleted
await key('K', 'KeyK', 75, 2 | 8)
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('3 changes')`, 'three changes')
steps.push({
  step: 'edited',
  label: await changesLabel(),
  marks: await marks(),
  dot: await ev(`!!document.querySelector('.tab--active .tab__dot')`)
})
check(JSON.stringify(steps.at(-1).marks) === JSON.stringify(['modified', 'added', 'deleted']), 'marks are not one per change kind')
check(steps.at(-1).dot, 'the tab does not say it differs from the database')
await shot('01-three-changes')

// --- 3. the peek shows what a change replaced, and reverts it alone ---------
await click(`document.querySelector('.cm-changeMark--modified').closest('.cm-gutterElement')`)
await waitFor(`!!document.querySelector('.cm-changePeek')`, 'the peek')
steps.push({
  step: 'peek',
  count: await ev(`document.querySelector('.cm-changePeek__count').textContent`),
  what: await ev(`document.querySelector('.cm-changePeek__what').textContent`),
  stored: await ev(`[...document.querySelectorAll('.cm-changePeek__text')].map(t => t.textContent)`)
})
check(steps.at(-1).count === 'Change 1 of 3', 'peek does not say which change it is')
check(steps.at(-1).stored[0] === '  SELECT order_id, customer_id', 'peek does not show the stored line')
await shot('02-peek')

await ev(`document.querySelector('.cm-changePeek__btn--revert').click()`)
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('2 changes')`, 'two changes after the revert')
let lines = await editorLines()
steps.push({ step: 'reverted one', label: await changesLabel(), line6: lines[5], marks: await marks() })
check(lines[5] === '  SELECT order_id, customer_id', 'the change was not put back')
check(lines.includes('  -- only the ones asked for'), 'reverting one change took another with it')
check(!lines.some((line) => line.includes('ORDER BY')), 'reverting one change brought back another')
check(!(await ev(`!!document.querySelector('.cm-changePeek')`)), 'the peek stayed open on a change that is gone')

// --- 4. the revert is an edit like any other: Ctrl+Z takes it back -----------
await ev(`document.querySelector('.cm-content').focus()`)
await key('z', 'KeyZ', 90, 2)
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('3 changes')`, 'three changes after undo')
lines = await editorLines()
check(lines[5] === '  SELECT order_id, customer_id, total', 'undo did not bring the change back')

// --- 5. stepping between changes, from the toolbar and the keyboard ----------
await toLineEnd(1)
await ev(`document.querySelector('.query__nav .seg__opt[aria-label="Next change"]').click()`)
await waitFor(`!!document.querySelector('.cm-changePeek')`, 'the peek from the toolbar')
const fromToolbar = await ev(`document.querySelector('.cm-changePeek__count').textContent`)
await ev(`document.querySelector('.cm-content').focus()`)
await key('F5', 'F5', 116, 1) // Alt+F5
await delay(200)
const fromKeyboard = await ev(`document.querySelector('.cm-changePeek__count').textContent`)
await key('F5', 'F5', 116, 1 | 8) // Shift+Alt+F5
await delay(200)
const back = await ev(`document.querySelector('.cm-changePeek__count').textContent`)
steps.push({ step: 'stepping', fromToolbar, fromKeyboard, back })
check(fromToolbar === 'Change 1 of 3' && fromKeyboard === 'Change 2 of 3' && back === 'Change 1 of 3', 'stepping between changes went astray')
await shot('03-stepping')

// --- 6. Ctrl+Alt+Z reverts the change under the cursor -----------------------
await toLineEnd(8) // the added comment line
await key('z', 'KeyZ', 90, 2 | 1)
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('2 changes')`, 'two changes after Ctrl+Alt+Z')
lines = await editorLines()
check(!lines.includes('  -- only the ones asked for'), 'Ctrl+Alt+Z did not revert the added line')

// --- 7. revert all ---------------------------------------------------------------
await ev(`[...document.querySelectorAll('.query__toolbar .btn')].find(b => b.textContent.trim() === 'Revert all').click()`)
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('No changes')`, 'no changes after revert all')
lines = await editorLines()
steps.push({
  step: 'reverted all',
  same: JSON.stringify(lines) === JSON.stringify(opened),
  dot: await ev(`!!document.querySelector('.tab--active .tab__dot')`)
})
check(steps.at(-1).same, 'revert all did not restore the definition as it was opened')
check(!steps.at(-1).dot, 'the tab still says it differs from the database')

// --- 8. running the whole script saves it, and the marks start again from it --
await toLineEnd(6)
await send('Input.insertText', { text: ', total' })
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('1 change')`, 'one change')
await ev(`[...document.querySelectorAll('.query__toolbar .btn')].find(b => b.textContent.includes('Run')).click()`)
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('No changes')`, 'no changes after saving', 30000)
const stored = await ev(`(async () => {
  const [connection] = await window.api.listConnections()
  return window.api.getObjectDefinition(connection.id, 'dbo', 'usp_e2e_orders')
})()`)
steps.push({ step: 'saved', storedHasEdit: stored.includes('customer_id, total') })
check(steps.at(-1).storedHasEdit, 'running the tab did not save the routine')
await shot('04-saved')

// A selection run is not a save: the marks stay.
await toLineEnd(5)
await send('Input.insertText', { text: ' -- note' })
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('1 change')`, 'one change before a partial run')
await key('Home', 'Home', 36, 2)
await key('ArrowDown', 'ArrowDown', 40, 8) // select the first line only
await key('Enter', 'Enter', 13, 2 | 8) // Ctrl+Shift+Enter: run the selection
await delay(1500)
check((await changesLabel()) === '1 change', 'a partial run moved the baseline')

// --- 9. opening it again shows the same tab ----------------------------------
// A plain query tab first — the blank one the window opened with, which `+`
// reuses — and it has no gutter for changes at all.
await ev(`document.querySelector('.tabbar__new').click()`)
await waitFor(`document.querySelector('.tab--active .tab__title')?.textContent.trim() === 'Query'`, 'a plain query tab')
const plainGutter = await ev(`!!document.querySelector('.cm-changeGutter')`)
const tabCount = await ev(`document.querySelectorAll('.tab').length`)
await openRoutine()
await waitFor(`document.querySelector('.tab--active .tab__title')?.textContent.trim() === 'usp_e2e_orders'`, 'the routine tab again')
steps.push({
  step: 'reopened',
  plainGutter,
  tabs: await ev(`document.querySelectorAll('.tab').length`),
  label: await changesLabel()
})
check(!plainGutter, 'a plain query tab has a change gutter')
check(steps.at(-1).tabs === tabCount, 'opening the routine again opened another tab')
check(steps.at(-1).label === '1 change', 'the reopened tab lost its edit')

// --- 10. closing it with its changes unsaved asks first -----------------------
const tabNamed = (title) =>
  `[...document.querySelectorAll('.tab')].find(t => t.querySelector('.tab__title')?.textContent.trim() === '${title}')`
const prompt = () =>
  waitFor(`document.querySelector('.modal__title')?.textContent.includes('This routine has changes')`, 'the close prompt')
const promptButton = (label) =>
  ev(`[...document.querySelectorAll('.modal__foot .btn')].find(b => b.textContent.trim() === '${label}').click()`)
const promptGone = () => waitFor(`!document.querySelector('.modal')`, 'the prompt to go')
const storedDefinition = () =>
  ev(`(async () => {
    const [connection] = await window.api.listConnections()
    return window.api.getObjectDefinition(connection.id, 'dbo', 'usp_e2e_orders')
  })()`)

await ev(`${tabNamed('usp_e2e_orders')}.querySelector('.tab__close').click()`)
await prompt()
steps.push({
  step: 'close prompt',
  subtitle: await ev(`document.querySelector('.modal__subtitle')?.textContent.trim()`),
  text: await ev(`document.querySelector('.modal__body .prompt__text')?.textContent.replace(/\\s+/g, ' ').trim()`),
  buttons: await ev(`[...document.querySelectorAll('.modal__foot .btn')].map(b => b.textContent.trim())`)
})
check(steps.at(-1).subtitle === 'dbo.usp_e2e_orders', 'the prompt does not say which routine')
check(JSON.stringify(steps.at(-1).buttons) === JSON.stringify(['Cancel', 'Discard', 'Save and close']), 'the prompt offers the wrong choices')
await shot('05-close-prompt')

// Cancel keeps it, edits and all.
await promptButton('Cancel')
await promptGone()
check(await ev(`!!${tabNamed('usp_e2e_orders')}`), 'Cancel closed the tab')
check((await changesLabel()) === '1 change', 'Cancel lost the edit')

// From the background too: Close all, with the plain tab on screen, still asks.
await ev(`${tabNamed('Query')}.click()`)
await waitFor(`document.querySelector('.tab--active .tab__title')?.textContent.trim() === 'Query'`, 'the plain tab on screen')
await ev(`${tabNamed('Query')}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 60 })), true`)
await waitFor(`!!document.querySelector('.menu')`, 'the tab menu')
await ev(`[...document.querySelectorAll('.menu .menu__item')].find(b => b.textContent.includes('Close all')).click()`)
await prompt()
await promptButton('Cancel')
await promptGone()
check((await ev(`document.querySelectorAll('.tab').length`)) === 2, 'Close all went ahead past a Cancel')

// Discard closes it, and the server keeps what it had.
await ev(`${tabNamed('usp_e2e_orders')}.querySelector('.tab__close').click()`)
await prompt()
await promptButton('Discard')
await promptGone()
await waitFor(`!${tabNamed('usp_e2e_orders')}`, 'the discarded tab to close')
const afterDiscard = await storedDefinition()
check(!afterDiscard.includes('-- note') && afterDiscard.includes('customer_id, total'), 'Discard wrote to the server')

// Nothing unsaved, nothing to ask.
await openRoutine()
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('No changes')`, 'the routine, unchanged')
await ev(`${tabNamed('usp_e2e_orders')}.querySelector('.tab__close').click()`)
await waitFor(`!${tabNamed('usp_e2e_orders')}`, 'an unchanged routine to close')
check(!(await ev(`!!document.querySelector('.modal')`)), 'an unchanged routine asked before closing')

// Save and close writes it to the server, then closes.
await openRoutine()
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('No changes')`, 'the routine again')
await toLineEnd(5)
await send('Input.insertText', { text: ' -- saved on close' })
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('1 change')`, 'an edit to save')
await ev(`${tabNamed('usp_e2e_orders')}.querySelector('.tab__close').click()`)
await prompt()
await promptButton('Save and close')
await waitFor(`!${tabNamed('usp_e2e_orders')}`, 'the saved tab to close', 30000)
check((await storedDefinition()).includes('-- saved on close'), 'Save and close did not save')

// A save that fails keeps the tab — and shows it, error and all, even when it
// was closed from the background.
await openRoutine()
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('No changes')`, 'the routine once more')
// Saved twice now, and read back: still one space after CREATE OR ALTER.
check((await editorLines())[0] === 'CREATE OR ALTER PROCEDURE dbo.usp_e2e_orders', 'saving widened the first line')
await toLineEnd(6)
await send('Input.insertText', { text: ', no_such_column' })
await waitFor(`document.querySelector('.query__changes')?.textContent.includes('1 change')`, 'an edit that will not compile')
await ev(`${tabNamed('Query')}.click()`)
await waitFor(`document.querySelector('.tab--active .tab__title')?.textContent.trim() === 'Query'`, 'the plain tab on screen again')
await ev(`${tabNamed('usp_e2e_orders')}.querySelector('.tab__close').click()`)
await prompt()
await promptButton('Save and close')
await promptGone()
await waitFor(`document.querySelector('.tab--active .tab__title')?.textContent.trim() === 'usp_e2e_orders'`, 'the failed tab on screen')
steps.push({
  step: 'failed save',
  open: await ev(`!!${tabNamed('usp_e2e_orders')}`),
  label: await changesLabel(),
  toast: await ev(`[...document.querySelectorAll('.toast__detail')].map(t => t.textContent.trim()).find(t => t.includes('no_such_column')) ?? null`)
})
check(steps.at(-1).label === '1 change', 'a failed save lost the edit')
check(steps.at(-1).toast, 'a failed save did not say why')
check(!(await storedDefinition()).includes('no_such_column'), 'a failed save reached the server')
await shot('06-failed-save')

await ev(`${tabNamed('usp_e2e_orders')}.querySelector('.tab__close').click()`)
await prompt()
await promptButton('Discard')
await waitFor(`!${tabNamed('usp_e2e_orders')}`, 'the tab to close at last')

await runSql('DROP PROCEDURE IF EXISTS dbo.usp_e2e_orders')

console.log('ROUTINES E2E PASS')
console.log(JSON.stringify(steps, null, 2))
child.kill('SIGKILL')
process.exit(0)
