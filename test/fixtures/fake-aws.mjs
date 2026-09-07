#!/usr/bin/env node
/**
 * A stand-in for `aws ssm start-session`, so the SSM tunnel can be tested
 * without an AWS account: it speaks the same CLI surface, prints the same
 * banner, opens the requested local port and proxies it to an upstream the
 * test controls.
 *
 * Behaviour is chosen with FAKE_AWS_SCENARIO; the invocation is recorded to
 * FAKE_AWS_ARGS_FILE so tests can assert on the exact command line.
 */
import net from 'node:net'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const scenario = process.env.FAKE_AWS_SCENARIO ?? 'ok'
const upstreamPort = Number(process.env.FAKE_AWS_UPSTREAM_PORT ?? 0)

if (process.env.FAKE_AWS_ARGS_FILE) {
  const env = {
    AWS_PAGER: process.env.AWS_PAGER,
    AWS_CLI_AUTO_PROMPT: process.env.AWS_CLI_AUTO_PROMPT
  }
  // Tests can ask for extra variables to be echoed back, to prove which
  // credentials actually reached the process.
  for (const name of (process.env.FAKE_AWS_ECHO_ENV ?? '').split(',').filter(Boolean)) {
    env[name] = process.env[name]
  }
  writeFileSync(process.env.FAKE_AWS_ARGS_FILE, JSON.stringify({ args, env }, null, 2))
}

const fail = (message, code) => {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

switch (scenario) {
  case 'plugin-missing':
    fail('SessionManagerPlugin is not found. Please refer to SessionManager Documentation here: http://docs.aws.amazon.com/console/systems-manager/session-manager-plugin-not-found', 255)
    break
  case 'target-not-connected':
    fail('An error occurred (TargetNotConnected) when calling the StartSession operation: i-0123456789abcdef0 is not connected.', 254)
    break
  case 'access-denied':
    fail('An error occurred (AccessDeniedException) when calling the StartSession operation: User: arn:aws:iam::111122223333:user/dev is not authorized to perform: ssm:StartSession', 254)
    break
  case 'expired':
    fail('The security token included in the request is expired', 253)
    break
  case 'no-credentials':
    fail('Unable to locate credentials. You can configure credentials by running "aws configure".', 253)
    break
  case 'bad-profile':
    fail('The config profile (nope) could not be found', 253)
    break
  case 'port-in-use':
    fail('Port 11433: bind: address already in use', 254)
    break
  case 'hang':
    // Never opens the port; exercises the start timeout.
    setInterval(() => {}, 1000)
    break
  default:
    startForwarder()
}

function parameterValue(name) {
  const index = args.indexOf('--parameters')
  if (index < 0) return undefined
  const parsed = JSON.parse(args[index + 1])
  return parsed[name]?.[0]
}

function startForwarder() {
  const localPort = Number(parameterValue('localPortNumber'))
  const sessionId = 'fake-session-0123456789'

  const server = net.createServer((socket) => {
    if (!upstreamPort) {
      socket.end()
      return
    }
    const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort })
    socket.on('error', () => socket.destroy())
    upstream.on('error', () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
  })

  server.on('error', (error) => fail(String(error), 254))

  server.listen(localPort, '127.0.0.1', () => {
    // Match the real CLI's output closely enough to be a fair stand-in.
    process.stdout.write(`\nStarting session with SessionId: ${sessionId}\n`)
    process.stdout.write(`Port ${localPort} opened for sessionId ${sessionId}.\n`)
    process.stdout.write('Waiting for connections...\n')
  })

  const shutdown = () => {
    process.stdout.write(`\nExiting session with sessionId: ${sessionId}.\n`)
    server.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
