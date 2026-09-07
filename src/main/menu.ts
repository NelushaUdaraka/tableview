/**
 * The native application menu.
 *
 * The items come from the shared menu model, which the renderer also draws in
 * the custom title bar. On Windows and Linux the native bar is hidden — the
 * window is frameless and the title bar draws the menus itself — but the menu
 * is still installed, because that is what makes the accelerators fire.
 */
import { BrowserWindow, Menu, MenuItemConstructorOptions, app, shell } from 'electron'
import { CHANNELS } from '../shared/ipc'
import { MenuAction, MenuItemModel, MenuRole, buildMenuModel } from '../shared/menu'

export type { MenuAction, MenuRole } from '../shared/menu'

/** Electron's role names for the roles the model uses. */
const ELECTRON_ROLES: Record<MenuRole, MenuItemConstructorOptions['role']> = {
  about: 'about',
  services: 'services',
  hide: 'hide',
  hideOthers: 'hideOthers',
  unhide: 'unhide',
  quit: 'quit',
  undo: 'undo',
  redo: 'redo',
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  selectAll: 'selectAll',
  resetZoom: 'resetZoom',
  zoomIn: 'zoomIn',
  zoomOut: 'zoomOut',
  toggleFullScreen: 'togglefullscreen',
  toggleDevTools: 'toggleDevTools',
  minimize: 'minimize',
  closeWindow: 'close'
}

export function buildMenu(getWindow: () => BrowserWindow | null, onNewWindow: () => void): Menu {
  const send = (action: MenuAction) => (): void => {
    getWindow()?.webContents.send(CHANNELS.eventMenuAction, action)
  }

  const isMac = process.platform === 'darwin'

  function toElectronItem(item: MenuItemModel): MenuItemConstructorOptions {
    if (item.separator) return { type: 'separator' }

    const base: MenuItemConstructorOptions = { label: item.label }
    // Electron only reads the accelerator from a role when none is given, and
    // the roles' defaults already match the model, so pass ours through.
    if (item.accelerator) base.accelerator = item.accelerator

    if (item.role) return { ...base, role: ELECTRON_ROLES[item.role] }
    if (item.action) return { ...base, click: send(item.action) }
    if (item.command === 'window:new') return { ...base, click: onNewWindow }
    if (item.link) {
      const url = item.link
      return { ...base, click: () => void shell.openExternal(url) }
    }
    return base
  }

  const template: MenuItemConstructorOptions[] = buildMenuModel(process.platform).map((menu) => ({
    // `&` marks the Alt mnemonic on Windows and Linux; macOS shows it verbatim.
    label: isMac ? menu.label : `&${menu.label}`,
    submenu: menu.items.map(toElectronItem)
  }))

  return Menu.buildFromTemplate(template)
}

/**
 * Runs one of the menu roles on behalf of the title bar's copy of the menu.
 * The renderer cannot reach the clipboard, the zoom level or the window frame,
 * so those items come back here.
 */
export function runMenuRole(role: MenuRole, window: BrowserWindow | null): void {
  const contents = window?.webContents

  switch (role) {
    case 'undo':
      contents?.undo()
      break
    case 'redo':
      contents?.redo()
      break
    case 'cut':
      contents?.cut()
      break
    case 'copy':
      contents?.copy()
      break
    case 'paste':
      contents?.paste()
      break
    case 'selectAll':
      contents?.selectAll()
      break
    case 'resetZoom':
      contents?.setZoomLevel(0)
      break
    case 'zoomIn':
      if (contents) contents.setZoomLevel(Math.min(9, contents.getZoomLevel() + 0.5))
      break
    case 'zoomOut':
      if (contents) contents.setZoomLevel(Math.max(-8, contents.getZoomLevel() - 0.5))
      break
    case 'toggleFullScreen':
      if (window) window.setFullScreen(!window.isFullScreen())
      break
    case 'toggleDevTools':
      contents?.toggleDevTools()
      break
    case 'minimize':
      window?.minimize()
      break
    case 'closeWindow':
      window?.close()
      break
    case 'quit':
      app.quit()
      break
    case 'about':
      app.showAboutPanel()
      break
    // The remaining macOS roles are only ever shown in the system menu bar.
    case 'services':
    case 'hide':
    case 'hideOthers':
    case 'unhide':
      break
  }
}
