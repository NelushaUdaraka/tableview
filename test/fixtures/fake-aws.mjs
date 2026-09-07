#!/usr/bin/env node
/**
 * A stand-in for the AWS CLI, so the SSM features can be tested without an AWS
 * account. It speaks the same surface the app uses:
 *
 *   aws --version                          the preflight's CLI check
 *   aws sts get-caller-identity            the preflight's credential check
 *   aws ec2 describe-instances             the bastion picker
 *   aws ssm describe-instance-information  the bastion picker's reachability
 *   aws ssm start-session                  the tunnel itself — prints the same
 *                                          banner, opens the requested local
 *                                          port and proxies it to an upstream
 *                                          the test controls
 *
 * Behaviour is chosen with FAKE_AWS_SCENARIO; the invocation is recorded to
 * FAKE_AWS_ARGS_FILE so tests can assert on the exact command line. The fleet
 * the describe calls report lives in FAKE_AWS_REGION only, so selecting the
 * wrong region produces the empty list a real account would.
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

const ok = (payload) => {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  process.exit(0)
}

const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const subcommand = `${args[0] ?? ''} ${args[1] ?? ''}`.trim()
const region = process.env.FAKE_AWS_REGION ?? 'eu-west-2'
/** The region the CLI would resolve: the flag, then the environment. */
const askedRegion = flag('--region') ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION

// Credentials fail the same way whatever the caller asked for.
switch (scenario) {
  case 'expired':
    fail('The security token included in the request is expired', 253)
    break
  case 'no-credentials':
    fail('Unable to locate credentials. You can configure credentials by running "aws configure".', 253)
    break
  case 'bad-profile':
    fail('The config profile (nope) could not be found', 253)
    break
  default:
    break
}

if (args[0] === '--version' || args[0] === 'version') {
  process.stdout.write('aws-cli/2.31.0 Python/3.13.7 Linux/6.8.0 exe/x86_64 (fake)\n')
  process.exit(0)
}

if (subcommand === 'sts get-caller-identity') {
  ok({
    UserId: 'AROAEXAMPLEEXAMPLE:dev',
    Account: '111122223333',
    Arn: 'arn:aws:sts::111122223333:assumed-role/Developer/dev'
  })
}

if (subcommand === 'ec2 describe-instances') {
  if (scenario === 'ec2-denied') {
    fail(
      'An error occurred (UnauthorizedOperation) when calling the DescribeInstances operation: You are not authorized to perform this operation.',
      254
    )
  }
  ok({ Reservations: askedRegion === region ? fleet().map((i) => ({ Instances: [i] })) : [] })
}

if (subcommand === 'ssm describe-instance-information') {
  if (scenario === 'ssm-denied') {
    fail(
      'An error occurred (AccessDeniedException) when calling the DescribeInstanceInformation operation: User is not authorized to perform: ssm:DescribeInstanceInformation',
      254
    )
  }
  ok({
    InstanceInformationList:
      askedRegion === region
        ? [
            {
              InstanceId: 'i-0ba5711000fee1dad',
              PingStatus: 'Online',
              PlatformName: 'Amazon Linux',
              PlatformType: 'Linux',
              ComputerName: `ip-10-0-2-11.${region}.compute.internal`,
              IPAddress: '10.0.2.11',
              ResourceType: 'EC2Instance'
            },
            {
              InstanceId: 'i-0dead00beef001122',
              PingStatus: 'ConnectionLost',
              PlatformName: 'Amazon Linux',
              PlatformType: 'Linux',
              IPAddress: '10.0.2.12',
              ResourceType: 'EC2Instance'
            }
          ]
        : []
  })
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

/**
 * A small fleet with the shapes that matter: the bastion, an instance whose
 * agent has stopped answering, one Systems Manager cannot see at all, and one
 * that is stopped.
 */
function fleet() {
  return [
    {
      InstanceId: 'i-0ba5711000fee1dad',
      InstanceType: 't3.micro',
      State: { Name: 'running' },
      PrivateIpAddress: '10.0.2.11',
      Placement: { AvailabilityZone: `${region}a` },
      VpcId: 'vpc-0f1e2d3c',
      PlatformDetails: 'Linux/UNIX',
      LaunchTime: '2026-08-14T09:12:00+00:00',
      Tags: [{ Key: 'Name', Value: 'prod-bastion' }]
    },
    {
      InstanceId: 'i-0dead00beef001122',
      InstanceType: 't3.micro',
      State: { Name: 'running' },
      PrivateIpAddress: '10.0.2.12',
      Placement: { AvailabilityZone: `${region}b` },
      PlatformDetails: 'Linux/UNIX',
      Tags: [{ Key: 'Name', Value: 'old-bastion' }]
    },
    {
      InstanceId: 'i-0abc123def4567890',
      InstanceType: 'm5.large',
      State: { Name: 'running' },
      PrivateIpAddress: '10.0.3.40',
      Placement: { AvailabilityZone: `${region}a` },
      PlatformDetails: 'Linux/UNIX',
      Tags: [{ Key: 'Name', Value: 'app-server' }]
    },
    {
      InstanceId: 'i-00ff11ee22dd33cc4',
      InstanceType: 't3.small',
      State: { Name: 'stopped' },
      Placement: { AvailabilityZone: `${region}c` },
      PlatformDetails: 'Linux/UNIX',
      Tags: [{ Key: 'Name', Value: 'reporting-box' }]
    }
  ]
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
