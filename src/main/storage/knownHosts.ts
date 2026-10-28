/**
 * The SSH host keys the user has said to trust, one per address.
 *
 * TableView's own list rather than `~/.ssh/known_hosts`: that file is the
 * user's, in a format with hashed names and markers this has no business
 * rewriting.
 */
import { JsonStore } from './store'
import type { HostKey, HostKeyStore, HostKeyVerdict } from '../tunnel/hostKeys'

interface KnownHostsFile {
  hosts: Record<string, HostKey & { addedAt: string }>
}

/** `[host]:port`, as OpenSSH writes an address; names are not case-sensitive. */
function addressOf(host: string, port: number): string {
  return `[${host.trim().toLowerCase()}]:${port}`
}

export class KnownHosts implements HostKeyStore {
  private readonly store: JsonStore<KnownHostsFile>

  constructor(filePath: string) {
    this.store = new JsonStore<KnownHostsFile>(filePath, () => ({ hosts: {} }))
  }

  check(host: string, port: number, key: HostKey): HostKeyVerdict {
    const stored = this.store.read().hosts?.[addressOf(host, port)]
    if (!stored) return { status: 'new' }
    if (stored.type === key.type && stored.fingerprint === key.fingerprint) return { status: 'known' }
    return { status: 'changed', previous: { type: stored.type, fingerprint: stored.fingerprint } }
  }

  trust(host: string, port: number, key: HostKey): void {
    this.store.update((file) => ({
      hosts: {
        ...file.hosts,
        [addressOf(host, port)]: {
          type: key.type,
          fingerprint: key.fingerprint,
          addedAt: new Date().toISOString()
        }
      }
    }))
  }
}
