/**
 * Records the animations in the README.
 *
 * What it films is the real app: the build is launched on a virtual display of
 * its own, against the test environment's SQL Server, and driven with real
 * mouse and keyboard input (xdotool), so the pointer travels, hover states show
 * and typing goes through the editor's completion as it would for a person.
 * ffmpeg films the display, and each scene becomes a GIF in docs/images/.
 *
 * Every scene starts from a fresh profile and a freshly built demo database
 * (demo-data.mjs), so a scene recorded on its own looks the same as one
 * recorded with the rest.
 *
 * Needs the test environment (scripts/test-env.sh up), Xvfb, xdotool and
 * ffmpeg; gifsicle, when installed, makes the GIFs a little smaller.
 *
 * Usage: npm run readme:gifs [-- browse|edit|query|read-only ...]   (every scene by default)
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { APP_LOGIN, DEMO_DATABASE, seedDemoDatabase } from './demo-data.mjs'

const run = promisify(execFile)

const PROJECT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const WORK = `${PROJECT}/.tmp/readme-gifs`
const OUT = `${PROJECT}/docs/images`

/**
 * The window, and the display it fills. GitHub shows a README's images about
 * 830px wide, so the window is kept small enough for its text to survive
 * that, and large enough for a table to show several columns beside the tree.
 */
const WIDTH = 1200
const HEIGHT = 750
/** 20 frames a second is a whole number of hundredths, which is all a GIF can say. */
const FPS = 20
const PORT = 9240

const SERVER = {
  host: process.env.MSSQL_TEST_HOST ?? '127.0.0.1',
  port: Number(process.env.MSSQL_TEST_PORT ?? 11433),
  user: process.env.MSSQL_TEST_USER ?? 'sa',
  password: process.env.MSSQL_TEST_PASSWORD ?? 'Beekeeper#2024!'
}

const SETTINGS = {
  // Applying straight away keeps the scene on the edit rather than on the
  // review of the statements Apply sends.
  confirmBeforeApply: false,
  autoUpdate: false,
  // Opened in the scene that is about it, so the others show a wide grid.
  showRowPanel: false,
  rowPanelWidth: 320
}

// --- the saved connections the scenes show ----------------------------------

const SQL_LOGIN = { authType: 'sql', savePassword: true, options: { encrypt: true, trustServerCertificate: true } }

const LOCAL = {
  ...SQL_LOGIN,
  name: 'Local',
  group: 'Acme Coffee',
  host: SERVER.host,
  port: SERVER.port,
  database: DEMO_DATABASE,
  username: SERVER.user,
  password: SERVER.password,
  createdAt: '2026-03-02T09:00:00Z'
}

/**
 * The rest of the list on the connection screen. Only Local is ever opened;
 * these are there so the list looks like somebody's, groups and colours and
 * tunnels included.
 */
const LISTED = [
  {
    ...SQL_LOGIN,
    name: 'Reporting warehouse',
    group: 'Analytics',
    color: '#099268',
    host: 'reporting.acme.example',
    port: 1433,
    database: 'warehouse',
    username: 'report_reader',
    createdAt: '2026-01-12T09:00:00Z'
  },
  {
    ...SQL_LOGIN,
    name: 'Production',
    group: 'Acme Coffee',
    color: '#e03131',
    readOnly: true,
    host: 'sql-prod.acme.internal',
    port: 1433,
    database: DEMO_DATABASE,
    username: APP_LOGIN.user,
    ssm: {
      enabled: true,
      credentialSource: 'cli',
      target: 'name',
      instanceId: '',
      instanceName: 'prod-bastion',
      mode: 'remote-host',
      region: 'eu-west-1',
      startTimeoutMs: 30000
    },
    createdAt: '2026-02-03T09:00:00Z'
  },
  {
    ...SQL_LOGIN,
    name: 'Staging',
    group: 'Acme Coffee',
    color: '#b45309',
    host: 'sql-staging.acme.internal',
    port: 1433,
    database: DEMO_DATABASE,
    username: APP_LOGIN.user,
    ssh: {
      enabled: true,
      host: 'bastion.acme.example',
      port: 22,
      username: 'deploy',
      authMode: 'key',
      privateKeyPath: '~/.ssh/id_ed25519',
      keepaliveIntervalMs: 30000
    },
    createdAt: '2026-02-17T09:00:00Z'
  }
]

/** Production as the read-only scene opens it: the same server as Local, signed in as the app. */
const PRODUCTION = {
  ...SQL_LOGIN,
  name: 'Production',
  group: 'Acme Coffee',
  color: '#e03131',
  readOnly: true,
  host: SERVER.host,
  port: SERVER.port,
  database: DEMO_DATABASE,
  username: APP_LOGIN.user,
  password: APP_LOGIN.password
}

// --- what the scenes point at -----------------------------------------------

const connectButton = (name) =>
  `[...[...document.querySelectorAll('.row')].find((r) => r.querySelector('.row__name')?.textContent.trim() === ${JSON.stringify(name)})
     .querySelectorAll('.row__buttons .btn')].find((b) => b.textContent.includes('Connect'))`
const treeItem = (name) =>
  `[...document.querySelectorAll('.sidebar .item__name')].find((e) => e.textContent.trim() === ${JSON.stringify(name)})?.closest('.item')`
const header = (column) =>
  `[...document.querySelectorAll('.grid__th-name')].find((e) => e.textContent.trim() === ${JSON.stringify(column)})?.parentElement`
const cell = (row, column) =>
  `document.querySelectorAll('.grid__row')[${row}]?.querySelectorAll('.grid__cell')[
     [...document.querySelectorAll('.grid__th-name')].findIndex((e) => e.textContent.trim() === ${JSON.stringify(column)})]`
const toolbarButton = (label) => `document.querySelector('.data__toolbar [aria-label=${JSON.stringify(label)}]')`
const button = (text) =>
  `[...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.trim() === ${JSON.stringify(text)})`
/** The table's own Apply, which counts the staged changes; the filter bar has an Apply too. */
const applyButton = `[...document.querySelectorAll('.data__toolbar .btn')].find((b) => b.textContent.trim().startsWith('Apply'))`
const gridRows = `document.querySelectorAll('.grid__row').length`

// --- the scenes ---------------------------------------------------------------

const SCENES = {
  // Connecting, opening a table, sorting it, and following a foreign key from the row panel.
  browse: {
    connections: [...LISTED, LOCAL],
    pointer: [700, 640],
    async play(app) {
      await pause(1400)
      await click(app, connectButton('Local'))
      await app.waitFor(`document.querySelectorAll('.sidebar .item').length > 0`, 'the schema tree')
      await pause(900)

      await click(app, treeItem('orders'))
      await app.waitFor(`${gridRows} > 0`, 'the orders')
      await pause(900)

      // Newest first: the key column is already sorted, so one click turns it round.
      await click(app, header('order_id'))
      await app.waitFor(`${cell(0, 'order_id')}?.textContent.trim() === '11800'`, 'the newest order first')
      await pause(900)

      // The second order's customer is one who left preferences, which the panel shows as JSON.
      await click(app, cell(1, 'status'))
      await pause(500)
      await click(app, toolbarButton('Row details'))
      await app.waitFor(`document.querySelectorAll('.rowpanel__field').length > 0`, 'the row panel')
      await pause(1300)

      await click(app, `document.querySelector('.rowpanel__fk')`)
      await app.waitFor(
        `document.querySelector('.tab--active')?.textContent.includes('customers') && ${gridRows} === 1`,
        'the customer the order points at'
      )
      await pause(1300)

      await scroll(app, `document.querySelector('.rowpanel__fields')`, 8)
      await pause(2600)
    }
  },

  // Filtering with a raw WHERE, editing three orders in the grid, and applying the changes.
  edit: {
    connections: [LOCAL],
    pointer: [760, 420],
    async prepare(app) {
      await app.connect('Local')
      await app.ev(`${treeItem('orders')}.click()`)
      await app.waitFor(`${gridRows} > 0`, 'the orders')
    },
    async play(app) {
      await pause(1000)
      await click(app, toolbarButton('Filter'))
      await click(app, button('Raw WHERE'))
      await click(app, `document.querySelector('.filters__raw input')`)
      await moveTo(760, 420)
      await type("placed_at > '2026-10-15'")
      await pause(300)
      await press('Return')
      await app.waitFor(`${gridRows} === 9`, 'the week’s orders')
      await pause(900)

      // The three orders still waiting to ship, marked shipped one under another:
      // Enter keeps the edit and moves down, and typing over a cell starts the next.
      await click(app, cell(2, 'status'), { double: true })
      await moveTo(900, 620)
      await press('ctrl+a')
      await type('shipped')
      await press('Return')
      await type('shipped')
      await press('Return')
      await type('shipped')
      await press('Return')
      await pause(900)

      await click(app, applyButton)
      await app.waitFor(
        `[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Changes applied'))`,
        'the changes applied'
      )
      await moveTo(760, 420)
      await pause(2800)
    }
  },

  // Writing a query with completion from the schema, and running it.
  query: {
    connections: [LOCAL],
    pointer: [760, 300],
    async prepare(app) {
      await app.connect('Local')
      await app.waitFor(`!!document.querySelector('.cm-content')`, 'the query editor')
    },
    async play(app) {
      await pause(900)
      await click(app, `document.querySelector('.cm-content')`)
      // Out of the way of the text about to be typed.
      await moveTo(1000, 330)

      await typeLine(app, 'SELECT c.country, COUNT(*) AS orders, SUM(o.total) AS revenue')
      await press('Return')
      await type('FROM sales.or')
      await complete(app, 'orders')
      await typeLine(app, ' o')
      await press('Return')
      await type('JOIN dbo.cus')
      await complete(app, 'customers')
      await typeLine(app, ' c ON c.customer_id = o.customer_id')
      await press('Return')
      await typeLine(app, 'GROUP BY c.country')
      await press('Return')
      await typeLine(app, 'ORDER BY revenue DESC;')
      await pause(500)

      await press('ctrl+Return')
      await app.waitFor(`document.querySelectorAll('.results__body .grid__row').length > 0`, 'the results')
      await pause(3000)
    }
  },

  // A read-only production connection, in its red, refusing a DELETE.
  'read-only': {
    connections: [PRODUCTION],
    pointer: [760, 300],
    async prepare(app) {
      await app.connect('Production')
      await app.waitFor(`!!document.querySelector('.cm-content')`, 'the query editor')
    },
    async play(app) {
      await pause(1200)
      await click(app, `document.querySelector('.cm-content')`)
      await moveTo(1000, 330)
      await typeLine(app, 'DELETE FROM sales.orders')
      await press('Return')
      await typeLine(app, "WHERE status = 'cancelled';")
      await pause(500)
      await press('ctrl+Return')
      await app.waitFor(`!!document.querySelector('.message--error')`, 'the refusal')
      await pause(3600)
    }
  }
}

// --- input --------------------------------------------------------------------

let display = null
const pointer = { x: WIDTH / 2, y: HEIGHT / 2 }

function xdo(...args) {
  return run('xdotool', args.map(String), { env: { ...process.env, DISPLAY: display } })
}

const pause = (ms) => delay(ms)

/** Glides the pointer to a point, easing in and out, at about the pace of a hand. */
async function moveTo(x, y) {
  x = Math.round(x)
  y = Math.round(y)
  const distance = Math.hypot(x - pointer.x, y - pointer.y)
  const steps = Math.max(1, Math.round(Math.min(900, 220 + distance * 0.55) / 16))
  const args = []
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    args.push(
      'mousemove',
      Math.round(pointer.x + (x - pointer.x) * eased),
      Math.round(pointer.y + (y - pointer.y) * eased)
    )
    if (i < steps) args.push('sleep', '0.016')
  }
  await xdo(...args)
  pointer.x = x
  pointer.y = y
}

/** Moves to the middle of an element and clicks it, after a beat for its hover state. */
async function click(app, target, { double = false } = {}) {
  const [x, y] = await app.centre(target)
  await moveTo(x, y)
  await pause(160)
  if (double) await xdo('click', '--repeat', 2, '--delay', 90, 1)
  else await xdo('click', 1)
  await pause(120)
}

const type = (text) => xdo('type', '--delay', 45, text)
const press = (...keys) => xdo('key', '--delay', 90, ...keys)

const completion = (app) =>
  app.ev(
    `[...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((li) => [li.textContent, li.getAttribute('aria-selected') === 'true'])`
  )

/**
 * Types a line of SQL and closes any completion it leaves open, so the Enter
 * that follows starts a new line instead of accepting a suggestion.
 */
async function typeLine(app, text) {
  await type(text)
  await pause(250)
  if ((await completion(app)).length > 0) await press('Escape')
}

/** Picks a suggestion from the completion list the way a person would: arrows, then Enter. */
async function complete(app, label) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const options = await completion(app)
    const wanted = options.findIndex(([text]) => text === label)
    const selected = options.findIndex(([, isSelected]) => isSelected)
    if (wanted >= 0 && selected >= 0) {
      await pause(350)
      for (let i = selected; i < wanted; i += 1) {
        await press('Down')
        await pause(220)
      }
      await press('Return')
      return
    }
    await pause(100)
  }
  throw new Error(`no completion offered ${label}`)
}

/** Turns the mouse wheel over an element, a notch at a time. */
async function scroll(app, target, notches) {
  const [x, y] = await app.centre(target)
  await moveTo(x, y)
  await xdo('click', '--repeat', notches, '--delay', 70, 5)
}

// --- the app ------------------------------------------------------------------

class App {
  static async launch(scene) {
    const profile = `${WORK}/profile-${scene}`
    rmSync(profile, { recursive: true, force: true })
    mkdirSync(profile, { recursive: true })
    // Where the window opens, how big, and with what settings: written before
    // the first start, the same way the app would have left them.
    writeJson(`${profile}/window-state.json`, { width: WIDTH, height: HEIGHT, x: 0, y: 0, maximized: false })
    writeJson(`${profile}/settings.json`, SETTINGS)
    writeJson(`${profile}/ui-state.json`, { sidebarWidth: 240 })

    const child = spawn(
      `${PROJECT}/node_modules/.bin/electron`,
      ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${profile}`],
      {
        cwd: PROJECT,
        env: { ...process.env, DISPLAY: display, XCURSOR_THEME: 'Adwaita', XCURSOR_SIZE: '24' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const app = new App(child)
    child.stdout.on('data', (d) => app.logs.push(d.toString()))
    child.stderr.on('data', (d) => app.logs.push(d.toString()))
    await app.attach()
    return app
  }

  constructor(child) {
    this.child = child
    this.logs = []
    this.nextId = 1
    this.pending = new Map()
  }

  async attach() {
    let url
    for (let i = 0; i < 60 && !url; i += 1) {
      if (this.child.exitCode !== null) throw new Error(`Electron exited:\n${this.logs.join('')}`)
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        url = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl
      } catch {
        /* not listening yet */
      }
      if (!url) await delay(500)
    }
    if (!url) throw new Error('the app never opened a window')

    this.socket = new WebSocket(url)
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiting = message.id && this.pending.get(message.id)
      if (!waiting) return
      this.pending.delete(message.id)
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error)))
      else waiting.resolve(message.result)
    })
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve)
      this.socket.addEventListener('error', () => reject(new Error('could not reach the app over DevTools')))
    })
    await this.waitFor(`!!document.querySelector('.titlebar')`, 'the window to draw')
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 30000)
    })
  }

  async ev(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      throw new Error(`${result.exceptionDetails.exception?.description ?? 'evaluation failed'}\n  in: ${expression}`)
    }
    return result.result.value
  }

  async waitFor(expression, label, ms = 30000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await this.ev(`(() => { try { return !!(${expression}) } catch { return false } })()`)) return
      await delay(100)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  /** The middle of an element, in screen pixels: the window fills the display from its corner. */
  async centre(target) {
    await this.waitFor(target, `something to point at: ${target}`, 10000)
    return this.ev(`(() => {
      const box = (${target}).getBoundingClientRect()
      return [box.left + box.width / 2, box.top + box.height / 2]
    })()`)
  }

  async saveConnections(connections) {
    await this.ev(`(async () => {
      for (const connection of ${JSON.stringify(connections)}) await window.api.saveConnection(connection)
    })()`)
    await this.ev('location.reload()')
    await delay(1000)
    await this.waitFor(`document.querySelectorAll('.row').length === ${connections.length}`, 'the saved connections')
  }

  /** Opens a connection without filming it, for the scenes that start inside one. */
  async connect(name) {
    await this.ev(`${connectButton(name)}.click()`)
    await this.waitFor(`document.querySelectorAll('.sidebar .item').length > 0`, `the ${name} workspace`)
    await delay(500)
  }

  /** Gives the window the keyboard: with no window manager nothing else will. */
  async focus() {
    const { stdout } = await run('xdotool', ['search', '--sync', '--onlyvisible', '--name', 'TableView$'], {
      env: { ...process.env, DISPLAY: display }
    })
    await xdo('windowfocus', '--sync', stdout.trim().split('\n')[0])
    await this.waitFor('document.hasFocus()', 'the window to take focus')
  }

  async quit() {
    this.socket?.close()
    this.child.kill('SIGTERM')
    await delay(800)
    this.child.kill('SIGKILL')
  }
}

// --- filming ------------------------------------------------------------------

async function film(clip, action) {
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-loglevel', 'error', '-nostats', '-y',
      '-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(FPS),
      '-video_size', `${WIDTH}x${HEIGHT}`, '-i', `${display}+0,0`,
      '-c:v', 'libx264rgb', '-crf', '0', '-preset', 'ultrafast', clip
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  )
  const errors = []
  ffmpeg.stderr.on('data', (d) => errors.push(d.toString()))
  const finished = new Promise((resolve) => ffmpeg.on('exit', resolve))
  await delay(500)
  try {
    await action()
  } finally {
    ffmpeg.stdin.end('q')
    const code = await finished
    if (code !== 0) throw new Error(`ffmpeg could not film the display:\n${errors.join('')}`)
  }
}

/**
 * A palette made for each scene, and no dithering: the interface is flat
 * colour, which dithering only speckles. Each frame stores just the rectangle
 * that changed, which is what keeps a pointer gliding over a still window small.
 */
async function toGif(clip, gif) {
  await run('ffmpeg', [
    '-loglevel', 'error', '-y', '-i', clip,
    '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    '-loop', '0', gif
  ])
  if (await has('gifsicle')) await run('gifsicle', ['--batch', '-O3', gif])
}

// --- running it ---------------------------------------------------------------

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2))
}

async function has(tool) {
  try {
    await run('which', [tool])
    return true
  } catch {
    return false
  }
}

async function startDisplay() {
  let number = 90
  while (existsSync(`/tmp/.X11-unix/X${number}`) || existsSync(`/tmp/.X${number}-lock`)) number += 1
  const xvfb = spawn('Xvfb', [`:${number}`, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp'], {
    stdio: 'ignore'
  })
  for (let i = 0; i < 40 && !existsSync(`/tmp/.X11-unix/X${number}`); i += 1) await delay(250)
  if (!existsSync(`/tmp/.X11-unix/X${number}`)) throw new Error('Xvfb did not start')
  display = `:${number}`
  return xvfb
}

async function recordScene(name) {
  const scene = SCENES[name]
  console.log(`==> ${name}`)
  await seedDemoDatabase(SERVER)

  const app = await App.launch(name)
  try {
    await app.saveConnections(scene.connections)
    if (scene.prepare) await scene.prepare(app)
    await app.focus()
    pointer.x = scene.pointer[0]
    pointer.y = scene.pointer[1]
    await xdo('mousemove', ...scene.pointer)
    await pause(400)

    const clip = `${WORK}/${name}.mkv`
    await film(clip, () => scene.play(app))
    const gif = `${OUT}/${name}.gif`
    await toGif(clip, gif)
    console.log(`    ${gif.slice(PROJECT.length + 1)}  ${(statSync(gif).size / 1024).toFixed(0)} KB`)
  } catch (error) {
    console.error(app.logs.join('').split('\n').slice(-20).join('\n'))
    throw error
  } finally {
    await app.quit()
  }
}

const wanted = process.argv.slice(2)
const unknown = wanted.filter((name) => !SCENES[name])
if (unknown.length > 0) {
  console.error(`unknown scene: ${unknown.join(', ')}\nscenes: ${Object.keys(SCENES).join(', ')}`)
  process.exit(1)
}
for (const tool of ['Xvfb', 'xdotool', 'ffmpeg']) {
  if (!(await has(tool))) {
    console.error(`${tool} is needed: apt-get install -y xvfb xdotool ffmpeg gifsicle`)
    process.exit(1)
  }
}
try {
  await fetch(`http://127.0.0.1:${PORT}/json/version`)
  console.error(`something is already listening on port ${PORT}: an app left by an earlier run?`)
  process.exit(1)
} catch {
  /* free, as it should be */
}

mkdirSync(WORK, { recursive: true })
mkdirSync(OUT, { recursive: true })
console.log('==> building')
await run('npx', ['electron-vite', 'build'], { cwd: PROJECT })

const xvfb = await startDisplay()
let failed = false
try {
  for (const name of wanted.length > 0 ? wanted : Object.keys(SCENES)) await recordScene(name)
} catch (error) {
  console.error(`README GIFS FAIL: ${error.message}`)
  failed = true
} finally {
  xvfb.kill()
}
process.exit(failed ? 1 : 0)
