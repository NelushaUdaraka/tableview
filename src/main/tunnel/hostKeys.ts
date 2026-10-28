/**
 * Which SSH server a tunnel is talking to.
 *
 * A server proves who it is with its host key. Unchecked, the first machine to
 * answer on the bastion's address is taken at its word, and handed the SSH
 * password and everything sent through the tunnel. So a key is asked about the
 * first time it is seen, kept, and every later connection has to present the
 * same one — what `ssh` does with `known_hosts`.
 *
 * The question itself is put by whoever builds the policy: the app asks in a
 * dialog, a test answers for itself. Nothing here imports Electron.
 */
import { createHash } from 'node:crypto'

export interface HostKey {
  /** The algorithm, as the key names it: `ssh-ed25519`, `ecdsa-sha2-nistp256`. */
  type: string
  /** `SHA256:` and the unpadded base64 digest, as `ssh-keygen -l` prints it. */
  fingerprint: string
}

export type HostKeyVerdict =
  | { status: 'known' }
  | { status: 'new' }
  | { status: 'changed'; previous: HostKey }

export interface HostKeyQuestion {
  host: string
  port: number
  key: HostKey
  /** The key this address had before, when it now presents another. */
  previous?: HostKey
}

/** What a tunnel asks before it trusts a server. */
export interface HostKeyPolicy {
  /** Answered at once, during the handshake. */
  check(host: string, port: number, key: HostKey): HostKeyVerdict
  /** Answered by the user, after a handshake that was turned down. True keeps the key. */
  ask(question: HostKeyQuestion): Promise<boolean>
}

/** Where a policy keeps the keys it has been told to trust. */
export interface HostKeyStore {
  check(host: string, port: number, key: HostKey): HostKeyVerdict
  trust(host: string, port: number, key: HostKey): void
}

/** The key's name and fingerprint, from the blob the server sent. */
export function readHostKey(blob: Buffer): HostKey {
  // The blob opens with the algorithm's name, as a length-prefixed string.
  const length = blob.length >= 4 ? blob.readUInt32BE(0) : 0
  const type = length > 0 && length <= blob.length - 4 ? blob.toString('latin1', 4, 4 + length) : 'unknown'
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  return { type, fingerprint: `SHA256:${digest}` }
}

/**
 * The policy over a store and a way to ask: a key the user says yes to is
 * kept, and is known from then on.
 */
export function hostKeyPolicy(
  store: HostKeyStore,
  prompt: (question: HostKeyQuestion) => Promise<boolean>
): HostKeyPolicy {
  // Two tabs opening at once against a new bastion get one question between them.
  const asking = new Map<string, Promise<boolean>>()

  return {
    check: (host, port, key) => store.check(host, port, key),
    ask(question) {
      const id = `${question.host.toLowerCase()}|${question.port}|${question.key.fingerprint}`
      const pending = asking.get(id)
      if (pending) return pending
      const answer = prompt(question)
        .then((yes) => {
          if (yes) store.trust(question.host, question.port, question.key)
          return yes
        })
        // No answer is not a yes.
        .catch(() => false)
        .finally(() => asking.delete(id))
      asking.set(id, answer)
      return answer
    }
  }
}
