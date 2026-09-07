/**
 * SSH local port forwarding.
 *
 * Opens a loopback-only TCP listener and forwards every accepted socket over an
 * SSH channel to the database host, so the rest of the app can connect to
 * 127.0.0.1:<localPort> and stay unaware that a tunnel exists.
 */
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import { Client, ConnectConfig } from 'ssh2'
import type { SshConfig } from '../../shared/types'
import type { Tunnel, TunnelHandle, TunnelTarget } from './types'

export type { TunnelHandle, TunnelTarget } from './types'

export class SshTunnelError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown
  ) {
    super(message)
    this.name = 'SshTunnelError'
  }
}

/** Windows uses Pageant; every other platform uses the SSH_AUTH_SOCK socket. */
export function resolveAgentPath(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') return 'pageant'
  return process.env.SSH_AUTH_SOCK || undefined
}

/** Translates our stored config into an ssh2 connect config. */
export function buildSshConnectConfig(
  config: SshConfig,
  readFile: (path: string) => Buffer = (path) => fs.readFileSync(path),
  platform: NodeJS.Platform = process.platform
): ConnectConfig {
  if (!config.host) throw new SshTunnelError('SSH host is required')
  if (!config.username) throw new SshTunnelError('SSH username is required')

  const base: ConnectConfig = {
    host: config.host,
    port: config.port || 22,
    username: config.username,
    keepaliveInterval: config.keepaliveIntervalMs ?? 10000,
    readyTimeout: 20000
  }

  switch (config.authMode) {
    case 'password': {
      if (!config.password) throw new SshTunnelError('SSH password is required')
      return { ...base, password: config.password }
    }
    case 'privateKey': {
      if (!config.privateKeyPath) throw new SshTunnelError('SSH private key path is required')
      const resolved = expandHome(config.privateKeyPath, platform)
      let privateKey: Buffer
      try {
        privateKey = readFile(resolved)
      } catch (error) {
        throw new SshTunnelError(`Could not read SSH private key at ${resolved}`, error)
      }
      return {
        ...base,
        privateKey,
        ...(config.passphrase ? { passphrase: config.passphrase } : {})
      }
    }
    case 'agent': {
      const agent = resolveAgentPath(platform)
      if (!agent) {
        throw new SshTunnelError(
          'No SSH agent available (SSH_AUTH_SOCK is not set and this is not Windows)'
        )
      }
      return { ...base, agent }
    }
    default:
      throw new SshTunnelError(`Unsupported SSH auth mode: ${String(config.authMode)}`)
  }
}

/** Expands a leading `~` so users can paste `~/.ssh/id_rsa`. */
export function expandHome(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (!filePath.startsWith('~')) return filePath
  const home = platform === 'win32' ? process.env.USERPROFILE || os.homedir() : os.homedir()
  return filePath.replace(/^~(?=$|[/\\])/, home)
}

export class SshTunnel implements Tunnel {
  private client: Client | null = null
  private server: net.Server | null = null
  private sockets = new Set<net.Socket>()
  private closed = false
  private forwardError: Error | null = null

  constructor(
    private readonly config: SshConfig,
    private readonly target: TunnelTarget
  ) {}

  /**
   * The last channel-open failure, if any.
   *
   * Callers surface this instead of the driver's error: when the SSH server
   * refuses to forward (`AllowTcpForwarding no`, a `PermitOpen` restriction, or
   * an unreachable target), the database driver only ever sees its socket close
   * and reports an unhelpful "connection lost".
   */
  get lastForwardError(): Error | null {
    return this.forwardError
  }

  /** Connects and starts listening. Resolves once the local port is bound. */
  async open(): Promise<TunnelHandle> {
    const connectConfig = buildSshConnectConfig(this.config)
    const client = new Client()
    this.client = client

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        client.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        client.off('ready', onReady)
        reject(new SshTunnelError(`SSH connection failed: ${error.message}`, error))
      }
      client.once('ready', onReady)
      client.once('error', onError)
      try {
        client.connect(connectConfig)
      } catch (error) {
        reject(new SshTunnelError(`SSH connection failed: ${describe(error)}`, error))
      }
    })

    // Once connected, surface later drops as tunnel errors rather than crashes.
    client.on('error', (error) => {
      if (!this.closed) {
        // eslint-disable-next-line no-console
        console.error('[ssh-tunnel] connection error:', error.message)
      }
    })

    const server = net.createServer((socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => socket.destroy())

      client.forwardOut(
        socket.remoteAddress || '127.0.0.1',
        socket.remotePort || 0,
        this.target.host,
        this.target.port,
        (error, stream) => {
          if (error) {
            this.forwardError = error
            socket.destroy()
            // eslint-disable-next-line no-console
            console.error('[ssh-tunnel] forward failed:', error.message)
            return
          }
          stream.on('error', () => socket.destroy())
          socket.pipe(stream).pipe(socket)
        }
      )
    })
    this.server = server

    const localPort = await new Promise<number>((resolve, reject) => {
      server.once('error', (error) => reject(new SshTunnelError(`Local listener failed: ${error.message}`, error)))
      // Port 0 asks the OS for a free ephemeral port.
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new SshTunnelError('Could not determine the local tunnel port'))
      })
    })

    return {
      localHost: '127.0.0.1',
      localPort,
      close: () => this.close()
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve())
        // close() only fires once all sockets are gone; they already are.
        setTimeout(resolve, 1000).unref?.()
      })
      this.server = null
    }

    if (this.client) {
      this.client.end()
      this.client = null
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
