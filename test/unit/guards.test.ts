/**
 * What a window may ask the main process for: where it may go, which links
 * leave the app, and which files it may read. A page that got into the window
 * some other way would have the same API the app has, so these are the limits
 * that hold whatever is asking.
 */
import { describe, expect, it } from 'vitest'
import { GrantedFiles, isAppUrl, isWebPage } from '../../src/main/guards'

describe('isAppUrl', () => {
  const packaged = 'file:///opt/TableView/resources/app.asar/out/renderer/index.html'

  it('lets the app reload itself, and move between its own routes', () => {
    expect(isAppUrl(packaged, packaged)).toBe(true)
    expect(isAppUrl(`${packaged}#/settings`, packaged)).toBe(true)
    expect(isAppUrl(`${packaged}?x=1`, packaged)).toBe(true)
  })

  it('keeps a dropped file, or any other local page, out of the window', () => {
    expect(isAppUrl('file:///home/me/Downloads/report.html', packaged)).toBe(false)
    expect(isAppUrl('file:///opt/TableView/resources/app.asar/out/renderer/other.html', packaged)).toBe(false)
  })

  it('keeps the web out of the window', () => {
    expect(isAppUrl('https://example.com/', packaged)).toBe(false)
    expect(isAppUrl('http://localhost:5173/', packaged)).toBe(false)
  })

  it('lets the dev server reload, and nothing else on its host', () => {
    const dev = 'http://localhost:5173/'
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5173/#/x', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl('http://localhost:5173/evil.html', dev)).toBe(false)
  })

  it('turns down what is not a URL at all', () => {
    expect(isAppUrl('not a url', packaged)).toBe(false)
  })
})

describe('isWebPage', () => {
  it('opens web pages in the browser', () => {
    expect(isWebPage('https://learn.microsoft.com/sql')).toBe(true)
    expect(isWebPage('HTTPS://github.com/x')).toBe(true)
  })

  // shell.openExternal hands anything to the OS, which runs a program for a
  // file: or a custom scheme as readily as it opens a page.
  it('opens nothing else', () => {
    for (const url of [
      'http://example.com',
      'file:///C:/Windows/System32/calc.exe',
      'smb://attacker/share',
      'ms-msdt:/id PCWDiagnostic',
      'javascript:alert(1)',
      '',
      'https//missing-colon'
    ]) {
      expect(isWebPage(url)).toBe(false)
    }
  })
})

describe('GrantedFiles', () => {
  it('lets a window read the file its dialog just picked, once', () => {
    const granted = new GrantedFiles()
    granted.grant(1, '/home/me/query.sql')
    expect(granted.take(1, '/home/me/query.sql')).toBe(true)
    expect(granted.take(1, '/home/me/query.sql')).toBe(false)
  })

  it('lets no window read a file nobody picked', () => {
    expect(new GrantedFiles().take(1, '/home/me/.ssh/id_ed25519')).toBe(false)
  })

  it('keeps one window from reading what another picked', () => {
    const granted = new GrantedFiles()
    granted.grant(1, '/home/me/query.sql')
    expect(granted.take(2, '/home/me/query.sql')).toBe(false)
    expect(granted.take(1, '/home/me/query.sql')).toBe(true)
  })

  it('forgets a window that has gone', () => {
    const granted = new GrantedFiles()
    granted.grant(1, '/home/me/query.sql')
    granted.forget(1)
    expect(granted.take(1, '/home/me/query.sql')).toBe(false)
  })
})
