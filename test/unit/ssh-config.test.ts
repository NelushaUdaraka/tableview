import { describe, expect, it } from 'vitest'
import {
  SshTunnelError,
  buildSshConnectConfig,
  expandHome,
  resolveAgentPath
} from '../../src/main/tunnel/ssh'
import { DEFAULT_SSH_CONFIG, type SshConfig } from '../../src/shared/types'

function config(overrides: Partial<SshConfig> = {}): SshConfig {
  return {
    ...DEFAULT_SSH_CONFIG,
    enabled: true,
    host: 'bastion.example.com',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

const fakeKey = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----')
const readFile = (): Buffer => fakeKey

describe('buildSshConnectConfig', () => {
  it('builds a password config', () => {
    const built = buildSshConnectConfig(
      config({ authMode: 'password', password: 'hunter2' }),
      readFile
    )
    expect(built.host).toBe('bastion.example.com')
    expect(built.port).toBe(22)
    expect(built.username).toBe('deploy')
    expect(built.password).toBe('hunter2')
    expect(built.keepaliveInterval).toBe(DEFAULT_SSH_CONFIG.keepaliveIntervalMs)
  })

  it('defaults the port to 22', () => {
    expect(buildSshConnectConfig(config({ port: 0, authMode: 'password', password: 'x' }), readFile).port).toBe(22)
  })

  it('builds a private key config and includes the passphrase only when set', () => {
    const withPassphrase = buildSshConnectConfig(
      config({ authMode: 'privateKey', privateKeyPath: '/keys/id', passphrase: 'secret' }),
      readFile
    )
    expect(withPassphrase.privateKey).toBe(fakeKey)
    expect(withPassphrase.passphrase).toBe('secret')

    const without = buildSshConnectConfig(
      config({ authMode: 'privateKey', privateKeyPath: '/keys/id' }),
      readFile
    )
    expect('passphrase' in without).toBe(false)
  })

  it('reports an unreadable key file with its path', () => {
    expect(() =>
      buildSshConnectConfig(
        config({ authMode: 'privateKey', privateKeyPath: '/nope/id' }),
        () => {
          throw new Error('ENOENT')
        }
      )
    ).toThrow(/Could not read SSH private key at \/nope\/id/)
  })

  it('uses Pageant on Windows and SSH_AUTH_SOCK elsewhere', () => {
    const previous = process.env.SSH_AUTH_SOCK
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    try {
      expect(buildSshConnectConfig(config({ authMode: 'agent' }), readFile, 'linux').agent).toBe(
        '/tmp/agent.sock'
      )
      expect(buildSshConnectConfig(config({ authMode: 'agent' }), readFile, 'win32').agent).toBe(
        'pageant'
      )
    } finally {
      if (previous === undefined) delete process.env.SSH_AUTH_SOCK
      else process.env.SSH_AUTH_SOCK = previous
    }
  })

  it('explains when no agent is available', () => {
    const previous = process.env.SSH_AUTH_SOCK
    delete process.env.SSH_AUTH_SOCK
    try {
      expect(() => buildSshConnectConfig(config({ authMode: 'agent' }), readFile, 'linux')).toThrow(
        /No SSH agent available/
      )
    } finally {
      if (previous !== undefined) process.env.SSH_AUTH_SOCK = previous
    }
  })

  it('requires the fields it cannot invent', () => {
    expect(() => buildSshConnectConfig(config({ host: '' }), readFile)).toThrow(/host is required/)
    expect(() => buildSshConnectConfig(config({ username: '' }), readFile)).toThrow(
      /username is required/
    )
    expect(() => buildSshConnectConfig(config({ authMode: 'password' }), readFile)).toThrow(
      /password is required/
    )
    expect(() => buildSshConnectConfig(config({ authMode: 'privateKey' }), readFile)).toThrow(
      /private key path is required/
    )
  })

  it('throws SshTunnelError so callers can tell tunnel failures apart', () => {
    try {
      buildSshConnectConfig(config({ host: '' }), readFile)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(SshTunnelError)
    }
  })

  it('rejects an unknown auth mode', () => {
    // @ts-expect-error deliberately invalid
    expect(() => buildSshConnectConfig(config({ authMode: 'magic' }), readFile)).toThrow(
      /Unsupported SSH auth mode/
    )
  })
})

describe('expandHome', () => {
  it('expands a leading tilde', () => {
    const expanded = expandHome('~/.ssh/id_ed25519', 'linux')
    expect(expanded.startsWith('~')).toBe(false)
    expect(expanded.endsWith('/.ssh/id_ed25519')).toBe(true)
  })

  it('leaves other paths untouched', () => {
    expect(expandHome('/absolute/path')).toBe('/absolute/path')
    expect(expandHome('relative/path')).toBe('relative/path')
    // `~user` is another user's home, not ours — do not touch it.
    expect(expandHome('~other/key')).toBe('~other/key')
  })

  it('uses USERPROFILE on Windows', () => {
    const previous = process.env.USERPROFILE
    process.env.USERPROFILE = 'C:\\Users\\dev'
    try {
      expect(expandHome('~\\.ssh\\id', 'win32')).toBe('C:\\Users\\dev\\.ssh\\id')
    } finally {
      if (previous === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previous
    }
  })
})

describe('resolveAgentPath', () => {
  it('is pageant on Windows', () => {
    expect(resolveAgentPath('win32')).toBe('pageant')
  })
})
