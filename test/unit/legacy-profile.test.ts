/**
 * TableView used to be Beekeeper Clone, and Electron keeps an app's data in a
 * folder named after the app. The first launch under the new name copies the
 * old folder's contents across, so nobody opens TableView to an empty list.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { carryOverLegacyProfile } from '../../src/main/storage/legacyProfile'

const SAVED = {
  'connections.json': '{"version":1,"connections":[{"id":"c1","name":"Production"}]}',
  'history.json': '{"version":1,"entries":[]}',
  'saved-queries.json': '{"version":1,"queries":[{"id":"q1","name":"Orders"}]}',
  'settings.json': '{"theme":"light"}',
  'window-state.json': '{"width":1400,"height":900}',
  'secret.key': 'k'.repeat(32)
}

let root: string
let appData: string
let oldProfile: string
let newProfile: string

function writeProfile(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents, { mode: 0o600 })
  }
}

function contentsOf(dir: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {}
  return Object.fromEntries(
    fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')])
  )
}

function carryOver(userData = newProfile): string[] {
  return carryOverLegacyProfile({ appData, userData, name: 'TableView' })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-profile-'))
  appData = path.join(root, 'AppData')
  oldProfile = path.join(appData, 'beekeeper-clone')
  newProfile = path.join(appData, 'TableView')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('carrying a Beekeeper Clone profile over to TableView', () => {
  it('copies everything Beekeeper Clone saved into a new TableView profile', () => {
    writeProfile(oldProfile, SAVED)

    const copied = carryOver()

    expect(contentsOf(newProfile)).toEqual(SAVED)
    expect(copied.sort()).toEqual(Object.keys(SAVED).sort())
  })

  // On Windows the key that OS-protected passwords were encrypted under lives
  // in Chromium's Local State, beside the app's own files. Without it those
  // passwords would arrive but never decrypt.
  it("brings Chromium's Local State with them", () => {
    writeProfile(oldProfile, { ...SAVED, 'Local State': '{"os_crypt":{"encrypted_key":"abc"}}' })

    carryOver()

    expect(fs.readFileSync(path.join(newProfile, 'Local State'), 'utf8')).toBe(
      '{"os_crypt":{"encrypted_key":"abc"}}'
    )
  })

  it("leaves Beekeeper Clone's own folder as it was", () => {
    writeProfile(oldProfile, SAVED)

    carryOver()

    expect(contentsOf(oldProfile)).toEqual(SAVED)
  })

  it('copies only what Beekeeper Clone actually saved', () => {
    writeProfile(oldProfile, {
      'connections.json': SAVED['connections.json'],
      'secret.key': SAVED['secret.key']
    })

    expect(carryOver().sort()).toEqual(['connections.json', 'secret.key'])
    expect(Object.keys(contentsOf(newProfile)).sort()).toEqual(['connections.json', 'secret.key'])
  })

  it('never overwrites a profile TableView has already written to', () => {
    writeProfile(oldProfile, SAVED)
    writeProfile(newProfile, { 'settings.json': '{"theme":"dark"}' })

    expect(carryOver()).toEqual([])
    expect(contentsOf(newProfile)).toEqual({ 'settings.json': '{"theme":"dark"}' })
  })

  it('never mixes old data into a profile TableView has already used', () => {
    writeProfile(oldProfile, {
      'connections.json': SAVED['connections.json'],
      'saved-queries.json': SAVED['saved-queries.json']
    })
    writeProfile(newProfile, { 'settings.json': '{"theme":"dark"}' })

    expect(carryOver()).toEqual([])
    expect(contentsOf(newProfile)).toEqual({ 'settings.json': '{"theme":"dark"}' })
  })

  it('keeps a Local State the new profile already has, and still brings the rest', () => {
    writeProfile(oldProfile, { ...SAVED, 'Local State': '{"from":"beekeeper-clone"}' })
    writeProfile(newProfile, { 'Local State': '{"from":"tableview"}' })

    carryOver()

    expect(contentsOf(newProfile)).toEqual({ ...SAVED, 'Local State': '{"from":"tableview"}' })
  })

  // Chromium writes files of its own into the profile; they are not a sign
  // that TableView has saved anything there.
  it('still carries over into a folder holding only Chromium files', () => {
    writeProfile(oldProfile, SAVED)
    writeProfile(newProfile, { 'Preferences': '{}' })

    carryOver()

    expect(contentsOf(newProfile)).toEqual({ ...SAVED, Preferences: '{}' })
  })

  it('does nothing when there is no Beekeeper Clone profile', () => {
    expect(carryOver()).toEqual([])
    expect(fs.existsSync(newProfile)).toBe(false)
  })

  it('does nothing when Beekeeper Clone saved nothing of its own', () => {
    writeProfile(oldProfile, { 'Local State': '{}' })

    expect(carryOver()).toEqual([])
    expect(fs.existsSync(newProfile)).toBe(false)
  })

  // The end-to-end suites launch with --user-data-dir pointing at a throwaway
  // profile; a developer's real connections must not turn up in it.
  it('leaves a profile chosen with --user-data-dir alone', () => {
    writeProfile(oldProfile, SAVED)
    const chosen = path.join(root, 'project', '.tmp', 'profile-smoke')

    expect(carryOver(chosen)).toEqual([])
    expect(fs.existsSync(chosen)).toBe(false)
  })

  it('keeps the copied files private', () => {
    if (process.platform === 'win32') return
    writeProfile(oldProfile, SAVED)

    carryOver()

    expect(fs.statSync(path.join(newProfile, 'secret.key')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(newProfile, 'connections.json')).mode & 0o777).toBe(0o600)
  })

  // Half a profile would stop the next launch from trying again (it now has
  // files of its own) while missing whatever did not make it, so a failure
  // takes back what this attempt copied. It must not stop the app starting.
  it('takes back a copy that fails part-way, without throwing', () => {
    writeProfile(oldProfile, SAVED)
    fs.rmSync(path.join(oldProfile, 'window-state.json'))
    fs.mkdirSync(path.join(oldProfile, 'window-state.json'))

    expect(carryOver()).toEqual([])
    expect(contentsOf(newProfile)).toEqual({})
  })
})
