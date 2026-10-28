/**
 * SSH host keys: which server the tunnel is talking to.
 *
 * Without this the first machine to answer on the bastion's address is taken
 * at its word — and is handed the SSH password, and everything sent through
 * the tunnel. A key is asked about the first time it is seen, kept, and every
 * later connection has to present the same one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnownHosts } from '../../src/main/storage/knownHosts'
import { hostKeyPolicy, readHostKey, type HostKeyQuestion } from '../../src/main/tunnel/hostKeys'

/** The key blob from an OpenSSH public key line, as the server sends it. */
const blob = (line: string): Buffer => Buffer.from(line.split(' ')[1], 'base64')

// Fingerprints as `ssh-keygen -lf` printed them for these keys.
const KEY_A = blob(
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBXJX8b/Q7RQ+RJ87t5DThnL2KrWaBBOJAezdShnq2y6 fixture'
)
const FINGERPRINT_A = 'SHA256:hdUTuv/4RD2RrNjwVKxTsgqV3NS1GaMFaXJizJx1vwA'
const KEY_B = blob(
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINifk5rBQ8rtjBgjiIj8DswubRsQ/xWecWILKYQrzPPL fixture3'
)
const FINGERPRINT_B = 'SHA256:6tRkHYTMxJvxdvV6SCt5LHi91eAHYViEY8YAgoZP5OY'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-hostkeys-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('readHostKey', () => {
  it('names the key the way ssh does', () => {
    expect(readHostKey(KEY_A)).toEqual({ type: 'ssh-ed25519', fingerprint: FINGERPRINT_A })
    expect(readHostKey(KEY_B).fingerprint).toBe(FINGERPRINT_B)
  })
})

describe('KnownHosts', () => {
  const file = (): string => path.join(dir, 'known-hosts.json')

  it('knows nothing to begin with', () => {
    expect(new KnownHosts(file()).check('bastion', 22, readHostKey(KEY_A))).toEqual({ status: 'new' })
  })

  it('recognises a key once it is trusted, across restarts', () => {
    new KnownHosts(file()).trust('bastion', 22, readHostKey(KEY_A))
    expect(new KnownHosts(file()).check('bastion', 22, readHostKey(KEY_A))).toEqual({ status: 'known' })
  })

  it('says when a server answers with a different key, and what it had before', () => {
    const known = new KnownHosts(file())
    known.trust('bastion', 22, readHostKey(KEY_A))
    expect(known.check('bastion', 22, readHostKey(KEY_B))).toEqual({
      status: 'changed',
      previous: { type: 'ssh-ed25519', fingerprint: FINGERPRINT_A }
    })
  })

  it('keeps one key per address, as ssh does', () => {
    const known = new KnownHosts(file())
    known.trust('bastion', 22, readHostKey(KEY_A))
    expect(known.check('bastion', 2222, readHostKey(KEY_A))).toEqual({ status: 'new' })
    expect(known.check('Bastion', 22, readHostKey(KEY_A))).toEqual({ status: 'known' })
    known.trust('bastion', 22, readHostKey(KEY_B))
    expect(known.check('bastion', 22, readHostKey(KEY_A)).status).toBe('changed')
  })
})

describe('hostKeyPolicy', () => {
  const question = (key: Buffer): HostKeyQuestion => ({
    host: 'bastion',
    port: 22,
    key: readHostKey(key)
  })

  it('keeps a key the user accepts, and asks no more about it', async () => {
    const known = new KnownHosts(path.join(dir, 'k.json'))
    const asked: HostKeyQuestion[] = []
    const policy = hostKeyPolicy(known, async (q) => {
      asked.push(q)
      return true
    })
    expect(await policy.ask(question(KEY_A))).toBe(true)
    expect(policy.check('bastion', 22, readHostKey(KEY_A))).toEqual({ status: 'known' })
    expect(asked).toHaveLength(1)
  })

  it('keeps nothing the user turns down', async () => {
    const known = new KnownHosts(path.join(dir, 'k.json'))
    const policy = hostKeyPolicy(known, async () => false)
    expect(await policy.ask(question(KEY_A))).toBe(false)
    expect(policy.check('bastion', 22, readHostKey(KEY_A))).toEqual({ status: 'new' })
  })

  it('asks once when two connections meet the same new key together', async () => {
    let answer: (yes: boolean) => void = () => undefined
    let asked = 0
    const policy = hostKeyPolicy(new KnownHosts(path.join(dir, 'k.json')), () => {
      asked += 1
      return new Promise<boolean>((resolve) => (answer = resolve))
    })
    const both = Promise.all([policy.ask(question(KEY_A)), policy.ask(question(KEY_A))])
    answer(true)
    expect(await both).toEqual([true, true])
    expect(asked).toBe(1)
  })

  it('counts a prompt that fails as a no', async () => {
    const policy = hostKeyPolicy(new KnownHosts(path.join(dir, 'k.json')), async () => {
      throw new Error('no window to ask in')
    })
    expect(await policy.ask(question(KEY_A))).toBe(false)
  })
})
