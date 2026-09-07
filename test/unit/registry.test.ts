import { describe, expect, it } from 'vitest'
import { ConnectionRegistry } from '../../src/main/db/registry'
import {
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  type ConnectionConfig
} from '../../src/shared/types'

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'c1',
    name: 'Test',
    engine: 'sqlserver',
    host: '127.0.0.1',
    port: 11433,
    authType: 'sql',
    username: 'sa',
    password: 'x',
    savePassword: false,
    options: { ...DEFAULT_SQLSERVER_OPTIONS, connectTimeoutMs: 1000 },
    ssh: { ...DEFAULT_SSH_CONFIG },
    ssm: { ...DEFAULT_SSM_CONFIG },
    createdAt: '',
    updatedAt: '',
    ...overrides
  }
}

describe('ConnectionRegistry', () => {
  it('reports an unopened connection as disconnected', () => {
    const registry = new ConnectionRegistry()
    expect(registry.status('win1', 'missing')).toEqual({
      connectionId: 'missing',
      state: 'disconnected'
    })
  })

  it('throws a helpful error when asked for a connection that is not open', () => {
    const registry = new ConnectionRegistry()
    expect(() => registry.get('win1', 'missing')).toThrow(/not open/i)
    expect(registry.find('win1', 'missing')).toBeUndefined()
  })

  it('tracks no open connections to begin with', () => {
    expect(new ConnectionRegistry().openConnectionIds()).toEqual([])
    expect(new ConnectionRegistry().openCount).toBe(0)
  })

  it('keeps each window in its own namespace', async () => {
    const registry = new ConnectionRegistry()
    // The same connection id in two windows must not collide.
    await registry.open('win1', config({ port: 1, id: 'shared' }))
    await registry.open('win2', config({ port: 1, id: 'shared' }))

    expect(registry.status('win1', 'shared').state).toBe('error')
    expect(registry.status('win2', 'shared').state).toBe('error')
    // A window with no attempt of its own still reads as disconnected.
    expect(registry.status('win3', 'shared').state).toBe('disconnected')
  })

  it('closing one window leaves another window alone', async () => {
    const registry = new ConnectionRegistry()
    await registry.open('win1', config({ port: 1, id: 'a' }))
    await registry.open('win2', config({ port: 1, id: 'a' }))

    await registry.closeScope('win1')
    expect(registry.status('win1', 'a').state).toBe('disconnected')
    // win2's own error state survives its neighbour going away.
    expect(registry.status('win2', 'a').state).toBe('error')
  })

  it('closing something that was never opened is a no-op', async () => {
    const registry = new ConnectionRegistry()
    await expect(registry.close('win1', 'missing')).resolves.toBeUndefined()
    await expect(registry.closeAll()).resolves.toBeUndefined()
  })

  it('rejects an unknown engine instead of guessing a driver', async () => {
    const registry = new ConnectionRegistry()
    // @ts-expect-error deliberately invalid engine
    const status = await registry.open('win1', config({ engine: 'postgres' }))
    expect(status.state).toBe('error')
    expect(status.error?.message).toMatch(/Unsupported engine/)
  })

  it('reports a failed connection as an error state, not a throw', async () => {
    const registry = new ConnectionRegistry()
    const status = await registry.open('win1', config({ port: 1, id: 'unreachable' }))
    expect(status.state).toBe('error')
    expect(status.error?.message).toBeTruthy()
    // A failed open must not be left registered as usable.
    expect(registry.find('win1', 'unreachable')).toBeUndefined()
    expect(registry.status('win1', 'unreachable').state).toBe('error')
  })
})
