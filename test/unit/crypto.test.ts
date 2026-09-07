import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HybridVault,
  LocalKeyVault,
  SafeStorageVault,
  createVault,
  isEncrypted
} from '../../src/main/storage/crypto'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-crypto-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('LocalKeyVault', () => {
  it('round-trips a secret', () => {
    const vault = new LocalKeyVault(path.join(dir, 'secret.key'))
    const payload = vault.encrypt('hunter2')
    expect(payload).not.toContain('hunter2')
    expect(vault.decrypt(payload)).toBe('hunter2')
  })

  it('handles empty and unicode secrets', () => {
    const vault = new LocalKeyVault(path.join(dir, 'secret.key'))
    expect(vault.decrypt(vault.encrypt(''))).toBe('')
    expect(vault.decrypt(vault.encrypt('pässwörd 🐝'))).toBe('pässwörd 🐝')
  })

  it('produces a different ciphertext each time', () => {
    const vault = new LocalKeyVault(path.join(dir, 'secret.key'))
    expect(vault.encrypt('same')).not.toBe(vault.encrypt('same'))
  })

  it('reuses the key file across instances', () => {
    const keyPath = path.join(dir, 'secret.key')
    const payload = new LocalKeyVault(keyPath).encrypt('shared')
    expect(new LocalKeyVault(keyPath).decrypt(payload)).toBe('shared')
  })

  it('writes the key file with owner-only permissions', () => {
    const keyPath = path.join(dir, 'nested', 'secret.key')
    new LocalKeyVault(keyPath)
    expect(fs.existsSync(keyPath)).toBe(true)
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects a tampered payload, because GCM authenticates it', () => {
    const vault = new LocalKeyVault(path.join(dir, 'secret.key'))
    const payload = vault.encrypt('hunter2')
    const parts = payload.split(':')
    const corruptedBytes = Buffer.from(parts[3], 'base64')
    corruptedBytes[0] ^= 0xff
    const tampered = [parts[0], parts[1], parts[2], corruptedBytes.toString('base64')].join(':')
    expect(() => vault.decrypt(tampered)).toThrow()
  })

  it('rejects a payload encrypted under a different key', () => {
    const payload = new LocalKeyVault(path.join(dir, 'a.key')).encrypt('secret')
    expect(() => new LocalKeyVault(path.join(dir, 'b.key')).decrypt(payload)).toThrow()
  })

  it('rejects malformed input', () => {
    const vault = new LocalKeyVault(path.join(dir, 'secret.key'))
    expect(() => vault.decrypt('nonsense')).toThrow(/Not an AES payload/)
    expect(() => vault.decrypt('aes1:onlyonepart')).toThrow(/Malformed/)
  })

  it('regenerates the key when the file is the wrong size', () => {
    const keyPath = path.join(dir, 'secret.key')
    fs.writeFileSync(keyPath, Buffer.alloc(8))
    const vault = new LocalKeyVault(keyPath)
    expect(vault.decrypt(vault.encrypt('ok'))).toBe('ok')
    expect(fs.readFileSync(keyPath).length).toBe(32)
  })
})

/** Stand-in for Electron's safeStorage; base64 stands for the OS keystore. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`os:${text}`, 'utf8'),
  decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^os:/, '')
}

describe('SafeStorageVault', () => {
  it('round-trips through the OS API', () => {
    const vault = new SafeStorageVault(fakeSafeStorage)
    const payload = vault.encrypt('hunter2')
    expect(payload.startsWith('os1:')).toBe(true)
    expect(vault.decrypt(payload)).toBe('hunter2')
    expect(vault.isBackedByOs).toBe(true)
  })

  it('refuses a payload from the other scheme', () => {
    expect(() => new SafeStorageVault(fakeSafeStorage).decrypt('aes1:x:y:z')).toThrow(
      /Not an OS-encrypted payload/
    )
  })
})

describe('HybridVault', () => {
  it('encrypts with the primary and reads both formats', () => {
    const local = new LocalKeyVault(path.join(dir, 'secret.key'))
    const hybrid = new HybridVault(new SafeStorageVault(fakeSafeStorage), local)

    const fresh = hybrid.encrypt('new-secret')
    expect(fresh.startsWith('os1:')).toBe(true)
    expect(hybrid.decrypt(fresh)).toBe('new-secret')

    // A value written before the keyring was available still opens.
    expect(hybrid.decrypt(local.encrypt('legacy'))).toBe('legacy')
  })

  it('reports that it is OS-backed', () => {
    const hybrid = new HybridVault(
      new SafeStorageVault(fakeSafeStorage),
      new LocalKeyVault(path.join(dir, 'k'))
    )
    expect(hybrid.isBackedByOs).toBe(true)
  })
})

describe('createVault', () => {
  it('prefers safeStorage when it is available', () => {
    expect(createVault(dir, fakeSafeStorage).isBackedByOs).toBe(true)
  })

  it('falls back when safeStorage is unavailable', () => {
    const vault = createVault(dir, { ...fakeSafeStorage, isEncryptionAvailable: () => false })
    expect(vault.isBackedByOs).toBe(false)
    expect(vault.decrypt(vault.encrypt('x'))).toBe('x')
  })

  it('falls back when safeStorage throws', () => {
    const vault = createVault(dir, {
      ...fakeSafeStorage,
      isEncryptionAvailable: () => {
        throw new Error('not ready')
      }
    })
    expect(vault.isBackedByOs).toBe(false)
  })

  it('falls back when there is no safeStorage at all', () => {
    expect(createVault(dir).isBackedByOs).toBe(false)
  })
})

describe('isEncrypted', () => {
  it('recognises both payload prefixes', () => {
    expect(isEncrypted('os1:abc')).toBe(true)
    expect(isEncrypted('aes1:a:b:c')).toBe(true)
    expect(isEncrypted('plaintext')).toBe(false)
  })
})
