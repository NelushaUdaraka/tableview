import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveCommand } from '../../src/main/tunnel/executable'

let dir: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-exec-'))
  fs.writeFileSync(path.join(dir, 'aws.EXE'), '')
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('resolveCommand', () => {
  const env = (): NodeJS.ProcessEnv => ({ PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' })

  it('resolves a bare name on Windows against PATH, not the working directory', () => {
    expect(resolveCommand('aws', 'win32', env())).toBe(path.join(dir, 'aws.EXE'))
  })

  it('returns the bare name when PATH has no match (so it fails the usual way)', () => {
    expect(resolveCommand('session-manager-plugin', 'win32', env())).toBe('session-manager-plugin')
  })

  it('leaves an explicit path alone', () => {
    const explicit = 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe'
    expect(resolveCommand(explicit, 'win32', env())).toBe(explicit)
  })

  it('changes nothing off Windows, where the current directory is not searched', () => {
    expect(resolveCommand('aws', 'linux', env())).toBe('aws')
    expect(resolveCommand('aws', 'darwin', env())).toBe('aws')
  })
})
