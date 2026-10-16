/**
 * Bringing a Beekeeper Clone profile across to TableView.
 *
 * TableView used to be called Beekeeper Clone, and Electron keeps an app's
 * data in a folder named after the app — so after the rename everything the
 * old name saved (connections, history, saved queries, settings, window
 * layout and the key its local encryption uses) sat in a folder TableView
 * never looks in. The first launch under the new name copies it across, and
 * leaves the old folder where it is as a backup.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The folder Beekeeper Clone kept its data in, beside TableView's. */
export const LEGACY_PROFILE = 'beekeeper-clone'

/** The app's own files. Any one of them in a profile means it has been used. */
const APP_FILES = [
  'connections.json',
  'history.json',
  'saved-queries.json',
  'settings.json',
  'window-state.json',
  'secret.key'
]

/**
 * Chromium's own state file. On Windows it holds the key that passwords saved
 * under the operating system's protection were encrypted with, so they only
 * decrypt in a profile that has it.
 */
const LOCAL_STATE = 'Local State'

export interface ProfilePaths {
  /** Where every app's data folder lives: `app.getPath('appData')`. */
  appData: string
  /** The data folder this launch uses: `app.getPath('userData')`. */
  userData: string
  /** The app's name, which names its default data folder: `app.getName()`. */
  name: string
}

/**
 * Copies Beekeeper Clone's data into TableView's profile, and says what it copied.
 *
 * It only ever fills an unused profile: one that is TableView's default folder
 * and holds none of the app's files yet. A profile picked with --user-data-dir
 * (the end-to-end suites use throwaway ones) is somebody's deliberate choice,
 * and one TableView has written to is never overwritten.
 *
 * Run it before anything reads the profile — Chromium included, which loads
 * Local State as it starts. It never throws: a copy that fails takes back what
 * it had copied so the next launch can try again, and the app starts either way.
 */
export function carryOverLegacyProfile(paths: ProfilePaths): string[] {
  const from = path.join(paths.appData, LEGACY_PROFILE)
  const to = paths.userData

  if (path.resolve(to) !== path.resolve(paths.appData, paths.name)) return []
  if (APP_FILES.some((name) => fs.existsSync(path.join(to, name)))) return []
  const toCopy = APP_FILES.filter((name) => fs.existsSync(path.join(from, name)))
  if (toCopy.length === 0) return []
  if (fs.existsSync(path.join(from, LOCAL_STATE)) && !fs.existsSync(path.join(to, LOCAL_STATE))) {
    toCopy.push(LOCAL_STATE)
  }

  const copied: string[] = []
  try {
    fs.mkdirSync(to, { recursive: true })
    for (const name of toCopy) {
      fs.copyFileSync(path.join(from, name), path.join(to, name), fs.constants.COPYFILE_EXCL)
      copied.push(name)
    }
  } catch (error) {
    for (const name of copied) fs.rmSync(path.join(to, name), { force: true })
    // eslint-disable-next-line no-console
    console.error('[profile] could not copy the Beekeeper Clone profile:', error)
    return []
  }
  return copied
}
