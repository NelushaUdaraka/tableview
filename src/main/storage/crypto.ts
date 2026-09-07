/**
 * Credential encryption at rest.
 *
 * Prefers Electron's `safeStorage`, which is backed by DPAPI on Windows and the
 * platform keyring elsewhere. When that is unavailable — a headless Linux box
 * with no keyring, or a unit test — it falls back to AES-256-GCM under a
 * locally generated key file. The fallback protects against casual disclosure
 * only, which is why `isBackedByOs` is surfaced so the UI can say so.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface SecretVault {
  encrypt(plaintext: string): string
  decrypt(payload: string): string
  readonly isBackedByOs: boolean
}

const OS_PREFIX = 'os1:'
const LOCAL_PREFIX = 'aes1:'

export class LocalKeyVault implements SecretVault {
  readonly isBackedByOs = false
  private key: Buffer

  constructor(private readonly keyPath: string) {
    this.key = this.loadOrCreateKey()
  }

  private loadOrCreateKey(): Buffer {
    try {
      const existing = fs.readFileSync(this.keyPath)
      if (existing.length === 32) return existing
    } catch {
      /* no key yet */
    }
    const key = crypto.randomBytes(32)
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true })
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 })
    try {
      fs.chmodSync(this.keyPath, 0o600)
    } catch {
      /* chmod is a no-op on some Windows filesystems */
    }
    return key
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${LOCAL_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
  }

  decrypt(payload: string): string {
    if (!payload.startsWith(LOCAL_PREFIX)) {
      throw new Error('Not an AES payload')
    }
    const parts = payload.slice(LOCAL_PREFIX.length).split(':')
    // The ciphertext part is legitimately empty for an empty secret, so check
    // the shape rather than the truthiness of each part.
    if (parts.length !== 3) throw new Error('Malformed encrypted payload')
    const [ivB64, tagB64, dataB64] = parts
    if (!ivB64 || !tagB64) throw new Error('Malformed encrypted payload')

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivB64, 'base64')
    )
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final()
    ]).toString('utf8')
  }
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
}

export class SafeStorageVault implements SecretVault {
  readonly isBackedByOs = true

  constructor(private readonly safeStorage: SafeStorageLike) {}

  encrypt(plaintext: string): string {
    return OS_PREFIX + this.safeStorage.encryptString(plaintext).toString('base64')
  }

  decrypt(payload: string): string {
    if (!payload.startsWith(OS_PREFIX)) throw new Error('Not an OS-encrypted payload')
    return this.safeStorage.decryptString(Buffer.from(payload.slice(OS_PREFIX.length), 'base64'))
  }
}

/**
 * Reads either format, so a profile keeps working when the OS keyring becomes
 * available (or stops being available) between runs.
 */
export class HybridVault implements SecretVault {
  constructor(
    private readonly primary: SecretVault,
    private readonly fallback: SecretVault
  ) {}

  get isBackedByOs(): boolean {
    return this.primary.isBackedByOs
  }

  encrypt(plaintext: string): string {
    return this.primary.encrypt(plaintext)
  }

  decrypt(payload: string): string {
    try {
      if (payload.startsWith(OS_PREFIX) && this.primary.isBackedByOs) {
        return this.primary.decrypt(payload)
      }
      if (payload.startsWith(LOCAL_PREFIX)) {
        return this.fallback.decrypt(payload)
      }
      return this.primary.decrypt(payload)
    } catch {
      return this.fallback.decrypt(payload)
    }
  }
}

/** Builds the best vault available for this process. */
export function createVault(userDataDir: string, safeStorage?: SafeStorageLike): SecretVault {
  const local = new LocalKeyVault(path.join(userDataDir, 'secret.key'))
  try {
    if (safeStorage?.isEncryptionAvailable()) {
      return new HybridVault(new SafeStorageVault(safeStorage), local)
    }
  } catch {
    /* safeStorage throws before app-ready on some platforms */
  }
  return local
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(OS_PREFIX) || value.startsWith(LOCAL_PREFIX)
}
