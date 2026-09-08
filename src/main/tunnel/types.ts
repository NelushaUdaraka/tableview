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
  /**
   * Waits for `lastForwardError` to appear, up to `timeoutMs`.
   *
   * A transport that reports through a child process is inherently racy: the
   * driver's socket closes the instant the forward fails, but the explanation
   * arrives on a pipe a few milliseconds later. Without this the driver wins the
   * race and the user is told "socket hang up" instead of why.
   *
   * Optional: a transport that sets the error synchronously has nothing to wait
   * for, and callers fall back to reading `lastForwardError` directly.
   */
  waitForForwardError?(timeoutMs: number): Promise<Error | null>
  /**
   * What a connection that opened and then closed immediately most likely means
   * for this transport, when the transport itself reported nothing.
   *
   * Some forwards accept the local socket before anything has been dialled at
   * the far end, so a dead destination looks exactly like a healthy tunnel until
   * traffic flows. Callers use this only for driver errors that indicate the
   * socket dropped, never for a failure the server itself reported.
   */
  readonly droppedConnectionHint?: string
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

/**
 * Resolves once something is listening on the port, or rejects on timeout.
 *
 * `isReady` lets a transport that announces its own listener short-circuit the
 * probe. That matters for more than speed: probing costs a real TCP
 * connect-and-hang-up, and a forward that carries one client at a time can be
 * left in a torn-down state by it — the connection that follows is then
 * accepted and dropped, which the driver reports as a bare socket hang up.
 */
export async function waitForPort(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 30000,
  isAborted: () => string | null = () => null,
  isReady: () => boolean = () => false
): Promise<void> {
  const net = await import('node:net')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const aborted = isAborted()
    if (aborted) throw new Error(aborted)
    if (isReady()) return

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
