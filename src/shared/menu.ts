/**
 * The application menu, described once and rendered twice.
 *
 * The main process turns this model into a real Electron `Menu` — which is
 * what macOS shows in its system menu bar and, on every platform, what makes
 * the accelerators fire. The renderer turns the same model into the drop-downs
 * in the custom title bar, so the two can never drift apart.
 */

/** Sent to the renderer, which owns the state the item acts on. */
export type MenuAction =
  | 'connection:new'
  | 'connection:manage'
  | 'connections:import'
  | 'connections:import-tableplus'
  | 'connections:export'
  | 'connection:disconnect'
  | 'connection:toggle-read-only'
  | 'connection:toggle-confirm-writes'
  | 'tab:new-query'
  | 'tab:close'
  | 'tab:next'
  | 'tab:previous'
  | 'tab:detach'
  | 'query:open-file'
  | 'query:save'
  | 'query:save-as'
  | 'query:run'
  | 'query:run-selection'
  | 'query:run-current'
  | 'query:cancel'
  | 'query:format'
  | 'results:export'
  | 'results:copy'
  | 'view:quick-open'
  | 'view:activity'
  | 'view:toggle-sidebar'
  | 'view:toggle-row-panel'
  | 'view:split-tab'
  | 'view:close-split'
  | 'view:toggle-theme'
  | 'view:focus-filter'
  | 'schema:refresh'
  | 'help:shortcuts'
  | 'help:check-updates'

/**
 * Handled by the main process. These mirror Electron's menu roles, because the
 * title bar's copy of the menu has no other way to reach the clipboard, the
 * zoom level or the window itself.
 */
export type MenuRole =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'resetZoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'toggleFullScreen'
  | 'toggleDevTools'
  | 'minimize'
  | 'closeWindow'

/** Things neither the renderer nor a role can do on its own. */
export type MenuCommand = 'window:new'

export interface MenuItemModel {
  label?: string
  /** Electron accelerator syntax, e.g. `CmdOrCtrl+Shift+E`. */
  accelerator?: string
  separator?: boolean
  action?: MenuAction
  role?: MenuRole
  command?: MenuCommand
  /** Opened in the user's browser. */
  link?: string
  /**
   * Kept out of the in-app title bar. The macOS application menu lives in the
   * system menu bar, so repeating it inside the window would be wrong.
   */
  nativeOnly?: boolean
}

export interface MenuModel {
  label: string
  items: MenuItemModel[]
}

const SEPARATOR: MenuItemModel = { separator: true }

/** The whole menu, for `platform` as `process.platform` reports it. */
export function buildMenuModel(platform: string): MenuModel[] {
  const isMac = platform === 'darwin'

  const appMenu: MenuModel[] = isMac
    ? [
        {
          label: 'TableView',
          items: [
            { label: 'About TableView', role: 'about', nativeOnly: true },
            SEPARATOR,
            { label: 'Services', role: 'services', nativeOnly: true },
            SEPARATOR,
            { label: 'Hide TableView', role: 'hide', nativeOnly: true },
            { label: 'Hide Others', role: 'hideOthers', nativeOnly: true },
            { label: 'Show All', role: 'unhide', nativeOnly: true },
            SEPARATOR,
            { label: 'Quit TableView', role: 'quit', nativeOnly: true }
          ]
        }
      ]
    : []

  return [
    ...appMenu,
    {
      label: 'File',
      items: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', command: 'window:new' },
        { label: 'New Connection…', accelerator: 'CmdOrCtrl+Shift+N', action: 'connection:new' },
        {
          label: 'Manage Connections',
          accelerator: 'CmdOrCtrl+Shift+M',
          action: 'connection:manage'
        },
        { label: 'Import Connections…', action: 'connections:import' },
        { label: 'Import from TablePlus…', action: 'connections:import-tableplus' },
        { label: 'Export Connections…', action: 'connections:export' },
        SEPARATOR,
        { label: 'New Query Tab', accelerator: 'CmdOrCtrl+T', action: 'tab:new-query' },
        { label: 'Move Tab to New Window', action: 'tab:detach' },
        { label: 'Open SQL File…', accelerator: 'CmdOrCtrl+O', action: 'query:open-file' },
        { label: 'Save Query', accelerator: 'CmdOrCtrl+S', action: 'query:save' },
        { label: 'Save Query As…', accelerator: 'CmdOrCtrl+Shift+S', action: 'query:save-as' },
        SEPARATOR,
        { label: 'Export Results…', accelerator: 'CmdOrCtrl+Shift+E', action: 'results:export' },
        SEPARATOR,
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', action: 'tab:close' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'closeWindow' },
        { label: 'Toggle Read-only', action: 'connection:toggle-read-only' },
        { label: 'Toggle Confirm Writes', action: 'connection:toggle-confirm-writes' },
        { label: 'Disconnect', action: 'connection:disconnect' },
        SEPARATOR,
        isMac
          ? { label: 'Close', role: 'closeWindow', nativeOnly: true }
          : { label: 'Exit', role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: 'Redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', role: 'redo' },
        SEPARATOR,
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
        SEPARATOR,
        { label: 'Format SQL', accelerator: 'CmdOrCtrl+Shift+F', action: 'query:format' },
        { label: 'Focus Filter', accelerator: 'CmdOrCtrl+F', action: 'view:focus-filter' }
      ]
    },
    {
      label: 'Query',
      items: [
        { label: 'Run', accelerator: 'CmdOrCtrl+Return', action: 'query:run' },
        {
          label: 'Run Selection',
          accelerator: 'CmdOrCtrl+Shift+Return',
          action: 'query:run-selection'
        },
        {
          label: 'Run Current Statement',
          accelerator: 'CmdOrCtrl+Alt+Return',
          action: 'query:run-current'
        },
        { label: 'Cancel', accelerator: 'Escape', action: 'query:cancel' },
        SEPARATOR,
        { label: 'Copy Results', accelerator: 'CmdOrCtrl+Shift+C', action: 'results:copy' }
      ]
    },
    {
      label: 'View',
      items: [
        { label: 'Quick Open…', accelerator: 'CmdOrCtrl+P', action: 'view:quick-open' },
        SEPARATOR,
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', action: 'view:toggle-sidebar' },
        { label: 'Toggle Row Panel', accelerator: 'CmdOrCtrl+I', action: 'view:toggle-row-panel' },
        { label: 'Split Tab Right', accelerator: 'CmdOrCtrl+\\', action: 'view:split-tab' },
        { label: 'Close Split', accelerator: 'CmdOrCtrl+Shift+\\', action: 'view:close-split' },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+L', action: 'view:toggle-theme' },
        { label: 'Refresh Schema', accelerator: 'F5', action: 'schema:refresh' },
        { label: 'Activity Monitor', action: 'view:activity' },
        SEPARATOR,
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', action: 'tab:next' },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', action: 'tab:previous' },
        SEPARATOR,
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        SEPARATOR,
        {
          label: 'Toggle Full Screen',
          accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11',
          role: 'toggleFullScreen'
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          role: 'toggleDevTools'
        }
      ]
    },
    {
      label: 'Help',
      items: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', action: 'help:shortcuts' },
        {
          label: 'SQL Server Documentation',
          link: 'https://learn.microsoft.com/sql/t-sql/language-reference'
        },
        SEPARATOR,
        { label: 'Check for Updates…', action: 'help:check-updates' }
      ]
    }
  ]
}

const MAC_SYMBOLS: Record<string, string> = {
  cmdorctrl: '⌘',
  command: '⌘',
  cmd: '⌘',
  ctrl: '⌃',
  control: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  return: '↩',
  enter: '↩',
  escape: 'Esc',
  esc: 'Esc',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  plus: '+'
}

const OTHER_NAMES: Record<string, string> = {
  cmdorctrl: 'Ctrl',
  command: 'Ctrl',
  cmd: 'Ctrl',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  return: 'Enter',
  enter: 'Enter',
  escape: 'Esc',
  esc: 'Esc',
  plus: '+'
}

/** macOS writes its modifiers in this order regardless of how they were typed. */
const MAC_MODIFIER_ORDER = ['⌃', '⌥', '⇧', '⌘']

/**
 * Renders an accelerator the way the platform writes it: `⇧⌘E` on macOS,
 * `Ctrl+Shift+E` everywhere else.
 */
export function formatAccelerator(accelerator: string | undefined, platform: string): string {
  if (!accelerator) return ''
  const isMac = platform === 'darwin'

  const parts = accelerator.split('+').map((part) => {
    const key = part.trim().toLowerCase()
    const mapped = isMac ? MAC_SYMBOLS[key] : OTHER_NAMES[key]
    if (mapped) return mapped
    // Single letters read better capitalised; F5 and friends are already right.
    return part.length === 1 ? part.toUpperCase() : part
  })

  if (!isMac) return parts.join('+')

  const modifiers = parts
    .filter((part) => MAC_MODIFIER_ORDER.includes(part))
    .sort((a, b) => MAC_MODIFIER_ORDER.indexOf(a) - MAC_MODIFIER_ORDER.indexOf(b))
  const keys = parts.filter((part) => !MAC_MODIFIER_ORDER.includes(part))
  return [...modifiers, ...keys].join('')
}
