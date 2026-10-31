import { describe, expect, it } from 'vitest'
import { mayReuseDbSecret, mayReuseSshSecret } from '../../src/shared/connectionSecrets'

const stored = {
  host: 'db.internal',
  port: 1433,
  authType: 'sql' as const,
  username: 'sa',
  domain: undefined
}

describe('mayReuseDbSecret', () => {
  it('reuses when the form points at the same target', () => {
    expect(mayReuseDbSecret({ ...stored }, stored)).toBe(true)
  })

  it('reuses when only the database or an option changed (not sent here)', () => {
    // host/port/auth/user/domain all equal → still the same login target.
    expect(mayReuseDbSecret({ host: 'db.internal', port: 1433, authType: 'sql', username: 'sa' }, stored)).toBe(true)
  })

  it('withholds the password when the host changed', () => {
    expect(mayReuseDbSecret({ ...stored, host: 'attacker.example' }, stored)).toBe(false)
  })

  it('withholds the password when the port, login, auth type or domain changed', () => {
    expect(mayReuseDbSecret({ ...stored, port: 1434 }, stored)).toBe(false)
    expect(mayReuseDbSecret({ ...stored, username: 'other' }, stored)).toBe(false)
    expect(mayReuseDbSecret({ ...stored, authType: 'windows' }, stored)).toBe(false)
    expect(mayReuseDbSecret({ ...stored, domain: 'CORP' }, stored)).toBe(false)
  })
})

describe('mayReuseSshSecret', () => {
  const ssh = { host: 'bastion', port: 22, username: 'ops', authMode: 'password' as const }

  it('never reuses when nothing is stored', () => {
    expect(mayReuseSshSecret({ ...ssh }, undefined)).toBe(false)
  })

  it('reuses for the same SSH server', () => {
    expect(mayReuseSshSecret({ ...ssh }, ssh)).toBe(true)
    expect(mayReuseSshSecret(undefined, ssh)).toBe(true)
  })

  it('withholds when the SSH host, port, user or auth mode changed', () => {
    expect(mayReuseSshSecret({ ...ssh, host: 'evil' }, ssh)).toBe(false)
    expect(mayReuseSshSecret({ ...ssh, port: 2222 }, ssh)).toBe(false)
    expect(mayReuseSshSecret({ ...ssh, username: 'root' }, ssh)).toBe(false)
    expect(mayReuseSshSecret({ ...ssh, authMode: 'privateKey' }, ssh)).toBe(false)
  })
})
