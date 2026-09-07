import { describe, expect, it } from 'vitest'
import { buildMenuModel, formatAccelerator } from '../../src/shared/menu'
import type { MenuItemModel } from '../../src/shared/menu'

function items(platform: string): MenuItemModel[] {
  return buildMenuModel(platform).flatMap((menu) => menu.items)
}

describe('buildMenuModel', () => {
  it('names the top-level menus the title bar draws', () => {
    expect(buildMenuModel('win32').map((menu) => menu.label)).toEqual([
      'File',
      'Edit',
      'Query',
      'View',
      'Help'
    ])
  })

  it('adds the application menu on macOS only', () => {
    expect(buildMenuModel('darwin')[0].label).toBe('Beekeeper Clone')
    expect(buildMenuModel('linux')[0].label).toBe('File')
  })

  it('marks the macOS application menu as native-only, so it is not drawn twice', () => {
    const appMenu = buildMenuModel('darwin')[0]
    expect(appMenu.items.filter((item) => !item.separator).every((item) => item.nativeOnly)).toBe(
      true
    )
  })

  it('gives every actionable item exactly one thing to do', () => {
    for (const item of items('win32')) {
      if (item.separator) continue
      const kinds = [item.action, item.role, item.command, item.link].filter(Boolean)
      expect(kinds, item.label).toHaveLength(1)
    }
  })

  it('labels every item it shows', () => {
    for (const item of items('darwin')) {
      if (item.separator) continue
      expect(item.label, JSON.stringify(item)).toBeTruthy()
    }
  })

  it('binds no accelerator twice on one platform', () => {
    const seen = new Map<string, string>()
    for (const item of items('win32')) {
      if (!item.accelerator) continue
      expect(seen.has(item.accelerator), `${item.label} clashes with ${seen.get(item.accelerator)}`).toBe(false)
      seen.set(item.accelerator, item.label ?? '')
    }
  })

  it('offers the row panel from the View menu', () => {
    const view = buildMenuModel('linux').find((menu) => menu.label === 'View')
    expect(view?.items.some((item) => item.action === 'view:toggle-row-panel')).toBe(true)
  })

  it('quits on Windows and Linux but closes on macOS, where the app menu quits', () => {
    const file = (platform: string): MenuItemModel[] =>
      buildMenuModel(platform).find((menu) => menu.label === 'File')!.items
    expect(file('win32').some((item) => item.role === 'quit')).toBe(true)
    expect(file('darwin').some((item) => item.role === 'quit')).toBe(false)
  })
})

describe('formatAccelerator', () => {
  it('spells modifiers out on Windows and Linux', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+E', 'win32')).toBe('Ctrl+Shift+E')
    expect(formatAccelerator('CmdOrCtrl+Return', 'linux')).toBe('Ctrl+Enter')
  })

  it('uses symbols on macOS, in the order macOS writes them', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+E', 'darwin')).toBe('⇧⌘E')
    expect(formatAccelerator('Ctrl+Cmd+F', 'darwin')).toBe('⌃⌘F')
    expect(formatAccelerator('Alt+Cmd+I', 'darwin')).toBe('⌥⌘I')
  })

  it('leaves function keys and punctuation alone', () => {
    expect(formatAccelerator('F5', 'win32')).toBe('F5')
    expect(formatAccelerator('CmdOrCtrl+/', 'win32')).toBe('Ctrl+/')
  })

  it('has nothing to render for an item without a shortcut', () => {
    expect(formatAccelerator(undefined, 'darwin')).toBe('')
  })
})
