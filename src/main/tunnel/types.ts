/**
 * The shape every tunnel implementation shares.
 *
 * A tunnel exposes a loopback port; the database driver connects to that and
 * stays unaware of how the traffic actually reaches the server.
 */

export interface TunnelTarget {
  host: string
  port: number
}

export interface TunnelHandle {
  localHost: string
  localPort: number
  close(): Promise<void>
}

export interface Tunnel {
  open(): Promise<TunnelHandle>
  close(): Promise<void>
  /**
   * A failure the transport noticed that the database driver cannot see.
   *
   * When a tunnel refuses to carry traffic, the driver only observes its socket
   * closing and reports an unhelpful "connection lost"; callers surface this
   * instead when it is set.
   */
  readonly lastForwardError: Error | null
}

/** Asks the OS for a free loopback port by binding to port 0 and releasing it. */
export async function findFreePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        server.close()
        reject(new Error('Could not determine a free local port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

/** Resolves once something is listening on the port, or rejects on timeout. */
export async function waitForPort(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 30000,
  isAborted: () => string | null = () => null
): Promise<void> {
  const net = await import('node:net')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const aborted = isAborted()
    if (aborted) throw new Error(aborted)

    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port })
      const done = (result: boolean): void => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(result)
      }
      socket.setTimeout(1000)
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
      socket.once('timeout', () => done(false))
    })

    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`Timed out waiting for the local port ${port} to open`)
}
