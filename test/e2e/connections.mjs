/**
 * The connection list screen, in the real UI.
 *
 * Duplicating exists to make editing easier — copy the connection that works,
 * change the one field that differs — so most of what this suite checks is
 * that the copy arrives ready to edit and that the original comes out of it
 * untouched. The rest is what a list of five then needs: an order the reader
 * chooses, which has to still be there after a restart, and a toast whose
 * dismiss button is where they last saw it. No database is needed: nothing
 * here connects.
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

/**
 * A click the way a mouse makes one — mousedown, then mouseup.
 *
 * `element.click()` dispatches neither, so anything that listens for a
 * mousedown (a menu's click-away, for one) never sees it. Takes the same kind
 * of expression `row()` builds rather than a selector.
 */
const clickOn = async (expression, label) => {
  const at = await ev(`
    (() => {
      const el = ${expression}
      if (!el) return null
      const box = el.getBoundingClientRect()
      const x = Math.round(box.left + box.width / 2)
      const y = Math.round(box.top + box.height / 2)
      // An open menu covers the rows under it, and a click that lands on one
      // of its items instead is a confusing way to find that out.
      const top = document.elementFromPoint(x, y)
      return JSON.stringify({ x, y, hit: el === top || el.contains(top) })
    })()
  `).then((v) => (v ? JSON.parse(v) : null))
  if (!at) bail('nothing to click for ' + label)
  if (!at.hit) bail(`${label} is under something else`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { x: at.x, y: at.y, type, button: 'left', clickCount: 1 })
  }
}

/**
 * Picks an item out of a row's ⋮ menu.
 *
 * Everything but Connect lives there now, so this is how the suite edits and
 * duplicates. `.click()` dispatches no mousedown, which is what keeps the
 * menu's own click-away from closing it before the item is chosen.
 */
const rowMenu = async (name, label) => {
  await ev(`${row(name)}.querySelector('.row__menu').click()`)
  await waitFor(`!!document.querySelector('.menu')`, `the ⋮ menu on ${name}`)
  const clicked = await ev(`
    (() => {
      const item = [...document.querySelectorAll('.menu .menu__item')]
        .find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))
      if (!item) return null
      item.click()
      return item.textContent.trim()
    })()
  `)
  if (!clicked) bail(`no ${label} in the ⋮ menu on ${name}`)
  return clicked
}

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

// --- what a row offers --------------------------------------------------
// Connect is the one thing a row is for; the rest moved behind its ⋮, so what
// that menu holds, and where it opens, is the row's whole vocabulary now.
const menuOf = (name) => `${row(name)}.querySelector('.row__menu')`
const menuItemLabels = () =>
  ev(`JSON.stringify([...document.querySelectorAll('.menu .menu__item')].map((b) => b.textContent.trim()))`)
    .then(JSON.parse)
/** Where the open menu sits, relative to the button that opened it. */
const menuAnchor = (name) => ev(`
  (() => {
    const button = ${menuOf(name)}.getBoundingClientRect()
    const menu = document.querySelector('.menu').getBoundingClientRect()
    return JSON.stringify({
      below: menu.top >= button.bottom,
      reaches: Math.round(menu.right - button.right) >= 0,
      onScreen: menu.right <= window.innerWidth && menu.left >= 0 && menu.bottom <= window.innerHeight
    })
  })()
`).then(JSON.parse)

check('the row shows its read-only padlock, Connect and nothing else', await ev(`
  JSON.stringify([...${row('Local dev')}.querySelectorAll('.row__buttons .btn')].map((b) => b.textContent.trim() || b.getAttribute('aria-label')))
`).then(JSON.parse), ['Read-only for Local dev', 'Connect', 'More for Local dev'])

await clickOn(menuOf('Local dev'), 'the ⋮ on Local dev')
await waitFor(`!!document.querySelector('.menu')`, 'the ⋮ menu')
const rowActions = await menuItemLabels()
steps.push({ step: 'row menu', actions: rowActions, anchor: await menuAnchor('Local dev') })
check('its ⋮ carries the rest', rowActions, ['Connect', 'Edit…', 'Duplicate…', 'Turn on read-only', 'Delete'])
check('opened under the button that raised it', await menuAnchor('Local dev'), {
  below: true, reaches: true, onScreen: true
})
await shot('01b-row-menu')

// The button closes what it opened, rather than reopening it under itself.
await clickOn(menuOf('Local dev'), 'the ⋮ again')
await waitFor(`!document.querySelector('.menu')`, 'the menu closed')

// Another row's ⋮ moves the menu to that row rather than leaving it where it
// was. Opened from the lower row and moved up, because a menu hangs below the
// button that raised it and would otherwise be sitting on the one clicked next.
await clickOn(menuOf('Production reporting'), 'the ⋮ on Production reporting')
await waitFor(`!!document.querySelector('.menu')`, 'that row\u2019s menu')
await clickOn(menuOf('Local dev'), 'the ⋮ one row up')
await waitFor(`!!document.querySelector('.menu')`, 'the menu again')
check('another row re-anchors it', await menuAnchor('Local dev'), {
  below: true, reaches: true, onScreen: true
})
await clickOn(menuOf('Local dev'), 'the ⋮ once more')
await waitFor(`!document.querySelector('.menu')`, 'the menu closed again')

// Duplicate from the list. The copy opens in the form with its name selected,
// because renaming it is the first thing anyone does next.
await rowMenu('Production reporting', 'Duplicate')
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
await rowMenu('Production reporting', 'Edit')
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
await rowMenu('Production reporting (copy)', 'Duplicate')
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

// --- the order the list reads in -------------------------------------------
// Five connections is the point at which "the order they were made in" stops
// being the only order worth having. The picker is one setting, not one
// session, which is what the reload at the end is for.
const shownNames = () =>
  ev(`JSON.stringify([...${ROWS}].map((r) => r.querySelector('.row__name').textContent.trim()))`)
    .then(JSON.parse)

/**
 * Those same names in name order, sorted in the page.
 *
 * Collation is the browser's, not Node's: an expectation built out here would
 * be testing that two ICU versions agree rather than that the screen sorted.
 */
const nameOrder = () => ev(`
  JSON.stringify([...${ROWS}].map((r) => r.querySelector('.row__name').textContent.trim())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })))
`).then(JSON.parse)

/** The names newest-made first — the order the list opens on. */
const createdOrder = () => ev(`
  (async () => JSON.stringify((await window.api.listConnections())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((c) => c.name)))()
`).then(JSON.parse)

const pickSort = (key) => ev(`
  (() => {
    const el = document.querySelector('#connection-sort')
    el.value = ${JSON.stringify(key)}
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()
`)
const sortState = async () => ({
  key: await ev(`document.querySelector('#connection-sort').value`),
  direction: await ev(`document.querySelector('.screen__sort-flip').textContent.trim()`)
})

steps.push({ step: 'default order', sort: await sortState(), names: await shownNames() })
check('the list opens on the newest connection', await shownNames(), await createdOrder())
check('and the picker says which order that is', await sortState(), { key: 'created', direction: '↓' })

await pickSort('name')
await waitFor(`document.querySelector('.screen__sort-flip').textContent.trim() === '↑'`, 'sorted by name')
check('sorting by name reads A to Z', await shownNames(), await nameOrder())
await shot('06-sorted-by-name')

await ev(`document.querySelector('.screen__sort-flip').click()`)
await waitFor(`document.querySelector('.screen__sort-flip').textContent.trim() === '↓'`, 'name order flipped')
check('flipping it reads Z to A', await shownNames(), (await nameOrder()).reverse())

// The order is a setting rather than a session: it is still there on the way
// back in, which is the whole reason it is not kept in the store alone.
await ev('location.reload()')
await delay(1200)
await send('Runtime.enable')
await waitFor(`${ROWS}.length === 5`, 'the list again')
steps.push({ step: 'order after reload', sort: await sortState(), names: await shownNames() })
check('the order survives a reload', await sortState(), { key: 'name', direction: '↓' })
check('and the rows come back in it', await shownNames(), (await nameOrder()).reverse())

// --- groups ------------------------------------------------------------------
// A group is a name a connection carries rather than a record of its own, so
// the first one has to be typed into the form; once it exists the row menu can
// file the others under it.
const headings = () => ev(`
  JSON.stringify([...document.querySelectorAll('.group')].map((g) => ({
    name: g.querySelector('.group__name').textContent.trim(),
    count: Number(g.querySelector('.group__count').textContent.trim()),
    open: g.getAttribute('aria-expanded') === 'true'
  })))
`).then(JSON.parse)

/** Files a connection under a group through its ⋮, submenu and all. */
const moveToGroup = async (name, group) => {
  await ev(`${row(name)}.querySelector('.row__menu').click()`)
  await waitFor(`!!document.querySelector('.menu')`, `the ⋮ menu on ${name}`)
  // "Move to" opens on hover rather than on a click, so the row is entered.
  await ev(`
    (() => {
      const entry = [...document.querySelectorAll('.menu .menu__row')]
        .find((r) => r.textContent.includes('Move to'))
      entry.dispatchEvent(new MouseEvent('mouseenter'))
    })()
  `)
  await waitFor(`!!document.querySelector('.menu--sub')`, 'the Move to submenu')
  const clicked = await ev(`
    (() => {
      const item = [...document.querySelectorAll('.menu--sub .menu__item')]
        .find((b) => b.textContent.trim() === ${JSON.stringify(group)})
      if (!item) return null
      item.click()
      return item.textContent.trim()
    })()
  `)
  if (!clicked) bail(`no “${group}” to move ${name} into`)
}

check('nothing is filed to begin with', await headings(), [])

await rowMenu('Local dev', 'Edit')
await waitFor(`!!document.querySelector('.form__tabs')`, 'the form, to name a group')
await setInput('.form input[list="connection-groups"]', 'Everyday')
await ev(`document.querySelector('.form button[type=submit]').click()`)
await waitFor(`!document.querySelector('.form__tabs')`, 'form closed')
await waitFor(`!!document.querySelector('.group')`, 'the first heading')
steps.push({ step: 'first group', headings: await headings() })
// Four connections were never filed, so they gather under one quiet heading.
check('naming a group in the form makes one', await headings(), [
  { name: 'Everyday', count: 1, open: true },
  { name: 'Ungrouped', count: 4, open: true }
])

await moveToGroup('Staging reporting', 'Everyday')
await waitFor(`${row('Staging reporting')} !== undefined`, 'the moved row')
check('the ⋮ files another one under it', await headings(), [
  { name: 'Everyday', count: 2, open: true },
  { name: 'Ungrouped', count: 3, open: true }
])

const namesUnder = (group) => ev(`
  (() => {
    const heads = [...document.querySelectorAll('.table__body > *')]
    const start = heads.findIndex((el) => el.classList.contains('group') &&
      el.querySelector('.group__name').textContent.trim() === ${JSON.stringify(group)})
    const names = []
    for (const el of heads.slice(start + 1)) {
      if (el.classList.contains('group')) break
      names.push(el.querySelector('.row__name').textContent.trim())
    }
    return JSON.stringify(names)
  })()
`).then(JSON.parse)
check('and the rows sit under their own heading', (await namesUnder('Everyday')).sort(), [
  'Local dev',
  'Staging reporting'
])

// A heading folds the group away, and says so to anything reading the screen.
await clickOn(
  `[...document.querySelectorAll('.group')].find((g) => g.querySelector('.group__name').textContent.trim() === 'Everyday')`,
  'the Everyday heading'
)
await waitFor(`${ROWS}.length === 3`, 'the folded list')
check('folding one hides its rows and nothing else', await headings(), [
  { name: 'Everyday', count: 2, open: false },
  { name: 'Ungrouped', count: 3, open: true }
])
await shot('06b-groups-folded')

// Searching reaches into a folded group: the row being typed for is exactly
// the one a closed heading would be hiding.
await setInput('.screen__search-input', 'staging')
await waitFor(`${ROWS}.length === 1`, 'the search result')
check('a search reaches into the fold', await shownNames(), ['Staging reporting'])
await setInput('.screen__search-input', '')
await waitFor(`${ROWS}.length === 3`, 'the folded list again')

// Taking the last one out of a group takes the group with it.
await clickOn(
  `[...document.querySelectorAll('.group')].find((g) => g.querySelector('.group__name').textContent.trim() === 'Everyday')`,
  'the Everyday heading again'
)
await waitFor(`${ROWS}.length === 5`, 'the whole list')
await moveToGroup('Local dev', 'No group')
await moveToGroup('Staging reporting', 'No group')
await waitFor(`document.querySelectorAll('.group').length === 0`, 'no headings left')
steps.push({ step: 'groups emptied', headings: await headings() })
check('emptying a group removes it', await headings(), [])

// --- where the dismiss button sits ------------------------------------------
// Reported from the app: with a short message the ✕ ended up adrift in the
// middle of the toast, because the message rather than the toast was deciding
// where it went. Two toasts of very different lengths, side by side, is what
// that looked like — so that is what this raises.
await rowMenu('Local dev', 'Duplicate')
await waitFor(`!!document.querySelector('.form__tabs')`, 'form on the Local dev copy')
await ev(`document.querySelector('.form button[type=submit]').click()`)
await waitFor(`document.querySelectorAll('.toast').length >= 2`, 'a long toast and a short one')
const toasts = await ev(`
  JSON.stringify([...document.querySelectorAll('.toast')].map((toast) => {
    const box = toast.getBoundingClientRect()
    const close = toast.querySelector('.toast__close').getBoundingClientRect()
    return {
      lines: toast.querySelector('.toast__message').textContent.trim().length,
      width: Math.round(box.width),
      fromRight: Math.round(box.right - close.right),
      inside: close.right <= box.right && close.left >= box.left && close.top >= box.top
    }
  }))
`).then(JSON.parse)
steps.push({ step: 'toasts', toasts })
check('the toasts are all one width', new Set(toasts.map((t) => t.width)).size, 1)
check('so their dismiss buttons line up', new Set(toasts.map((t) => t.fromRight)).size, 1)
check('and each one is inside its own toast', toasts.every((t) => t.inside), true)
// Two messages of different lengths is the case that was wrong; if they came
// out the same length this proved nothing.
check('the two messages were different lengths', new Set(toasts.map((t) => t.lines)).size > 1, true)
await shot('07-toasts')

// --- from TablePlus -----------------------------------------------------------
// TablePlus hands a connection out as a URL (right-click → Copy as URL), and the
// New connection form takes one off the clipboard and fills itself in. The
// clipboard is read by the main process, which hands over a SQL Server URL from
// TablePlus and nothing else — so what this checks first is that anything else
// leaves the form exactly as it was. The URL is the one TablePlus for Windows
// copied, with every name and secret replaced.
const TP_URL =
  'microsoftsqlserver://appuser:Fake%7Bpw%27%7Cx%3B%29y~%60.z%3E9@127.0.0.1/appdb?statusColor=005392&env=development&name=App%20DEV&tLSMode=0&usePrivateKey=false&safeModeLevel=0&advancedSafeModeLevel=0&driverVersion=0&showSystemSchemas=0&driverVersion=0&lazyload=False'
const val = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.value ?? null`)
const tpText = () =>
  ev(`document.querySelector('.tpanel')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`)
const pasteTP = async (text) => {
  await ev(`window.api.copyToClipboard(${JSON.stringify(text)})`)
  await ev(`document.querySelector('.tpanel__paste').click()`)
}
const newConnection = async () => {
  await ev(`document.querySelector('.screen__actions .btn--primary').click()`)
  await waitFor(`!!document.querySelector('.tpanel')`, 'the TablePlus panel on a new connection')
}
const saveForm = async () => {
  await ev(`document.querySelector('.form button[type=submit]').click()`)
  await waitFor(`!document.querySelector('.form__tabs')`, 'the form to close')
}
const FIELD = {
  name: '.form input[placeholder="Production reporting"]',
  server: '.form input[placeholder="localhost"]',
  // The General tab comes first, and the Tunnel tab's fields stay in the page
  // while hidden, so the first of each of these is the General tab's.
  port: '.form__section input[type=number]',
  database: '.form input[placeholder="(default)"]',
  user: '.form input[placeholder="sa"]',
  password: '.form input[type=password]',
  group: '.form input[placeholder="(none)"]'
}
/** The App DEV rows as the window is told about them. */
const appDevs = () => ev(`
  (async () => JSON.stringify((await window.api.listConnections())
    .filter((c) => c.name === 'App DEV')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => ({
      host: c.host, port: c.port, database: c.database, username: c.username,
      color: c.color, group: c.group, readOnly: c.readOnly === true,
      hasSavedPassword: c.hasSavedPassword, passwordInWindow: c.password !== undefined
    }))))()
`).then(JSON.parse)

// A plain new connection offers the paste on one line, steps folded away.
await newConnection()
check('folded on a plain new connection', await ev(`!!document.querySelector('.tpanel__steps')`), false)
check('with a way to unfold the steps', await ev(`!!document.querySelector('.tpanel__toggle')`), true)

// Something that is not a TablePlus URL is turned down, and the form keeps
// what was typed into it.
await setInput(FIELD.name, 'Typed first')
await setInput(FIELD.group, 'Typed group')
await pasteTP('hunter2 is not a URL')
await waitFor(`document.querySelector('.tpanel')?.textContent.includes('does not hold a TablePlus URL')`, 'the clipboard turned down')
check('a refused paste leaves the name', await val(FIELD.name), 'Typed first')
check('a refused paste leaves the group', await val(FIELD.group), 'Typed group')

// Another database's URL is turned down by name; its password never arrives.
await pasteTP('postgres://u:pw@db.example.com:5432/app?name=Analytics')
await waitFor(`document.querySelector('.tpanel')?.textContent.includes('That is a PostgreSQL connection')`, 'the PostgreSQL URL turned down')
check('a PostgreSQL URL leaves the name', await val(FIELD.name), 'Typed first')
check('a PostgreSQL URL leaves the group', await val(FIELD.group), 'Typed group')

// The real thing replaces the whole form, typed fields included.
await pasteTP(TP_URL)
await waitFor(`document.querySelector('.tpanel')?.textContent.includes('Filled in from TablePlus')`, 'the form filled in from TablePlus')
const filled = {
  name: await val(FIELD.name),
  server: await val(FIELD.server),
  port: await val(FIELD.port),
  database: await val(FIELD.database),
  user: await val(FIELD.user),
  group: await val(FIELD.group),
  password: await val(FIELD.password),
  passwordType: await ev(`document.querySelector(${JSON.stringify(FIELD.password)}).type`),
  blue: await ev(`document.querySelector('.swatch[aria-label="Blue"]')?.getAttribute('aria-pressed')`),
  readOnly: await ev(`document.querySelector('.form__toggle input[type=checkbox]').checked`),
  status: await ev(`document.querySelector('.tpanel__status')?.textContent.replace(/\\s+/g, ' ').trim()`)
}
steps.push({ step: 'filled in from TablePlus', filled: { ...filled, password: '(masked)' } })
check('the form filled in from TablePlus', { ...filled, password: undefined }, {
  name: 'App DEV',
  server: '127.0.0.1',
  port: '1433',
  database: 'appdb',
  user: 'appuser',
  group: 'Development',
  passwordType: 'password',
  blue: 'true',
  readOnly: false,
  status: 'Filled in from TablePlus · password included · colour blue'
})
check('the password decoded exactly', filled.password, "Fake{pw'|x;)y~`.z>9")
check('nothing saved before Save', await appDevs(), [])
await shot('08-tableplus-filled')

// Saved through the ordinary path: the password is stored, and the window is
// only ever told that it is.
await saveForm()
const firstImport = await appDevs()
steps.push({ step: 'imported from TablePlus', connections: firstImport })
check('the import saved', firstImport, [{
  host: '127.0.0.1', port: 1433, database: 'appdb', username: 'appuser',
  color: '#1971c2', group: 'Development', readOnly: false,
  hasSavedPassword: true, passwordInWindow: false
}])

// The same URL again: the form says so, and saving adds a second one while the
// first stays exactly as it was.
await newConnection()
await pasteTP(TP_URL)
await waitFor(`document.querySelector('.tpanel')?.textContent.includes('Filled in from TablePlus')`, 'the second paste')
check('a name already saved is called out', (await tpText()).includes('You already have a connection called “App DEV”'), true)
await saveForm()
const afterSecond = await appDevs()
check('the second import sits beside the first', afterSecond.length, 2)
check('and the first is untouched', afterSecond[0], firstImport[0])

// No password in the URL: nothing is stored, so the connect asks for one
// rather than trying an empty one. A typed field the URL has nothing for goes
// back to blank.
await newConnection()
await setInput(FIELD.group, 'Typed group')
await pasteTP('microsoftsqlserver://appuser@127.0.0.1/appdb?name=No%20Password')
await waitFor(`document.querySelector('.tpanel')?.textContent.includes('Filled in from TablePlus')`, 'the URL with no password')
check('a field the URL lacks goes back to blank', await val(FIELD.group), '')
await saveForm()
const noPassword = await ev(`
  (async () => JSON.stringify((await window.api.listConnections())
    .filter((c) => c.name === 'No Password')
    .map((c) => ({ hasSavedPassword: c.hasSavedPassword, group: c.group ?? '' }))))()
`).then(JSON.parse)
check('no password came, so none is stored', noPassword, [{ hasSavedPassword: false, group: '' }])

// A tunnel with a key: the key file is the one thing the URL cannot carry, and
// both the panel and the Tunnel tab say so.
await newConnection()
await pasteTP('sqlserver+ssh://deploy:keypass@bastion.example.com/appuser:pw@10.0.0.5/appdb?name=Via%20Key&usePrivateKey=true')
await waitFor(`document.querySelector('.tpanel')?.textContent.includes('Filled in from TablePlus')`, 'the key tunnel URL')
check('the panel asks for the key file', (await tpText()).includes('Choose the SSH key file on the Tunnel tab'), true)
await ev(`[...document.querySelectorAll('.form__tab')].find((t) => t.textContent.trim().startsWith('Tunnel')).click()`)
check(
  'the Tunnel tab asks for it too',
  await ev(`document.querySelector('.form').textContent.includes('TablePlus does not put the key file in the URL')`),
  true
)
await shot('08-tableplus-key')
await ev(`[...document.querySelectorAll('.form__foot button')].find((b) => b.textContent.trim() === 'Cancel').click()`)
await waitFor(`!document.querySelector('.form__tabs')`, 'the form to close on Cancel')

const rendererErrors = logs.join('').split('\n')
  .filter((l) => /ERROR|Uncaught/i.test(l))
  .filter((l) => !/GPU|gpu_|dbus|libva|Vulkan|EGL|gbm|sandbox|DevTools|Fontconfig|MESA|swiftshader|CertVerif|ssl_client_socket/i.test(l))
  // The pastes turned down above fail in the main process by design.
  .filter((l) => !l.includes('clipboard:tablePlusUrl failed'))

console.log(JSON.stringify({ steps, failures, rendererErrors }, null, 2))
socket.close(); child.kill('SIGKILL')
process.exit(failures.length === 0 && rendererErrors.length === 0 ? 0 : 1)
