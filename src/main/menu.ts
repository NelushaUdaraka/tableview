/**
 * Application menu. Items that act on editor or grid state send a named action
 * to the renderer rather than trying to reach into it from here.
 */
import { BrowserWindow, Menu, MenuItemConstructorOptions, app, shell } from 'electron'
import { CHANNELS } from '../shared/ipc'

export type MenuAction =
  | 'connection:new'
  | 'connection:manage'
  | 'connection:disconnect'
  | 'tab:new-query'
  | 'tab:close'
  | 'tab:next'
  | 'tab:previous'
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
  | 'view:toggle-sidebar'
  | 'view:toggle-theme'
  | 'view:focus-filter'
  | 'schema:refresh'
  | 'help:shortcuts'

export function buildMenu(
  getWindow: () => BrowserWindow | null,
  onNewWindow: () => void
): Menu {
  const send = (action: MenuAction) => (): void => {
    getWindow()?.webContents.send(CHANNELS.eventMenuAction, action)
  }

  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: '&File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: onNewWindow },
        { label: 'New Connection…', accelerator: 'CmdOrCtrl+Shift+N', click: send('connection:new') },
        { label: 'Manage Connections', accelerator: 'CmdOrCtrl+Shift+M', click: send('connection:manage') },
        { type: 'separator' },
        { label: 'New Query Tab', accelerator: 'CmdOrCtrl+T', click: send('tab:new-query') },
        { label: 'Open SQL File…', accelerator: 'CmdOrCtrl+O', click: send('query:open-file') },
        { label: 'Save Query', accelerator: 'CmdOrCtrl+S', click: send('query:save') },
        { label: 'Save Query As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('query:save-as') },
        { type: 'separator' },
        { label: 'Export Results…', accelerator: 'CmdOrCtrl+Shift+E', click: send('results:export') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send('tab:close') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        { label: 'Disconnect', click: send('connection:disconnect') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Format SQL', accelerator: 'CmdOrCtrl+Shift+F', click: send('query:format') },
        { label: 'Focus Filter', accelerator: 'CmdOrCtrl+F', click: send('view:focus-filter') }
      ]
    },
    {
      label: '&Query',
      submenu: [
        { label: 'Run', accelerator: 'CmdOrCtrl+Return', click: send('query:run') },
        { label: 'Run Selection', accelerator: 'CmdOrCtrl+Shift+Return', click: send('query:run-selection') },
        { label: 'Run Current Statement', accelerator: 'CmdOrCtrl+Alt+Return', click: send('query:run-current') },
        { label: 'Cancel', accelerator: 'Escape', click: send('query:cancel') },
        { type: 'separator' },
        { label: 'Copy Results', accelerator: 'CmdOrCtrl+Shift+C', click: send('results:copy') }
      ]
    },
    {
      label: '&View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: send('view:toggle-sidebar') },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+L', click: send('view:toggle-theme') },
        { label: 'Refresh Schema', accelerator: 'F5', click: send('schema:refresh') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: send('tab:next') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: send('tab:previous') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: send('help:shortcuts') },
        {
          label: 'SQL Server Documentation',
          click: () => {
            void shell.openExternal('https://learn.microsoft.com/sql/t-sql/language-reference')
          }
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
