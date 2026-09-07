/**
 * Covers the bastion instance lookup: the CLI invocations it builds, how the
 * two AWS responses are parsed and merged, the order the picker sees, and what
 * each failure is turned into. The AWS CLI is stood in for by an injected
 * runner, so nothing here needs an account.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  InstanceLookupError,
  buildInstanceListCommand,
  classifyInstanceLookupFailure,
  listSsmInstances,
  mergeInstances,
  parseDescribeInstances,
  parseInstanceInformation,
  resolveRegion,
  sortInstances,
  type CliRun,
  type CliRunner
} from '../../src/main/tunnel/ec2Instances'
import { DEFAULT_SSM_CONFIG, type SsmConfig } from '../../src/shared/types'
import type { SsmInstance } from '../../src/shared/ipc'

function config(overrides: Partial<SsmConfig> = {}): SsmConfig {
  return { ...DEFAULT_SSM_CONFIG, enabled: true, region: 'eu-west-2', ...overrides }
}

function describeInstances(
  instances: Record<string, unknown>[],
  extra: Record<string, unknown> = {}
): string {
  // One instance per reservation, which is what a bastion launched on its own
  // actually looks like.
  return JSON.stringify({
    Reservations: instances.map((instance) => ({ Instances: [instance] })),
    ...extra
  })
}

const BASTION = {
  InstanceId: 'i-0aaa1111bbbb2222c',
  InstanceType: 't3.micro',
  State: { Name: 'running' },
  PrivateIpAddress: '10.0.2.11',
  PublicIpAddress: '52.1.2.3',
  Placement: { AvailabilityZone: 'eu-west-2a' },
  VpcId: 'vpc-0123',
  PlatformDetails: 'Linux/UNIX',
  LaunchTime: '2026-08-01T09:00:00+00:00',
  Tags: [
    { Key: 'Name', Value: 'prod-bastion' },
    { Key: 'env', Value: 'prod' }
  ]
}

const APP_SERVER = {
  InstanceId: 'i-0ddd3333eeee4444f',
  InstanceType: 'm5.large',
  State: { Name: 'stopped' },
  Tags: [{ Key: 'Name', Value: 'batch-runner' }]
}

/** Answers with a fixed response per subcommand. */
function runner(responses: Partial<Record<'ec2' | 'ssm', Partial<CliRun>>>): {
  run: CliRunner
  calls: { command: string; args: string[]; env: Record<string, string> }[]
} {
  const calls: { command: string; args: string[]; env: Record<string, string> }[] = []
  const run: CliRunner = async (command, args, env) => {
    calls.push({ command, args, env })
    const kind = args[0] === 'ec2' ? 'ec2' : 'ssm'
    const response = responses[kind] ?? {}
    return { code: response.code ?? 0, stdout: response.stdout ?? '{}', stderr: response.stderr ?? '' }
  }
  return { run, calls }
}

describe('buildInstanceListCommand', () => {
  it('asks EC2 for everything but terminated instances', () => {
    const built = buildInstanceListCommand(config(), 'ec2', 'eu-west-2')
    expect(built.command).toBe('aws')
    expect(built.args.slice(0, 2)).toEqual(['ec2', 'describe-instances'])
    const filter = built.args[built.args.indexOf('--filters') + 1]
    expect(filter).toContain('Name=instance-state-name')
    expect(filter).toContain('running')
    expect(filter).not.toContain('terminated')
    expect(built.args).toContain('--output')
    expect(built.args[built.args.indexOf('--region') + 1]).toBe('eu-west-2')
  })

  it('asks Systems Manager which of them it can reach', () => {
    const built = buildInstanceListCommand(config(), 'ssm', 'eu-west-2')
    expect(built.args.slice(0, 2)).toEqual(['ssm', 'describe-instance-information'])
    expect(built.args).not.toContain('--filters')
  })

  it('honours an explicit CLI path', () => {
    const built = buildInstanceListCommand(config({ awsCliPath: '/opt/aws/bin/aws' }), 'ec2')
    expect(built.command).toBe('/opt/aws/bin/aws')
  })

  it('passes a profile only when the CLI is resolving credentials', () => {
    const cli = buildInstanceListCommand(
      config({ credentialSource: 'cli', profile: 'prod' }),
      'ec2',
      'eu-west-2'
    )
    expect(cli.args[cli.args.indexOf('--profile') + 1]).toBe('prod')

    // A pasted block carries its own identity; --profile would override it.
    const pasted = buildInstanceListCommand(
      config({ credentialSource: 'pasted', profile: 'prod' }),
      'ec2',
      'eu-west-2'
    )
    expect(pasted.args).not.toContain('--profile')
  })

  it('omits the region when there is none to pass', () => {
    const built = buildInstanceListCommand(config({ region: '' }), 'ec2', undefined)
    expect(built.args).not.toContain('--region')
  })
})

describe('resolveRegion', () => {
  it('prefers the configured region over the credentials', () => {
    expect(resolveRegion(config({ region: 'eu-west-2' }), { AWS_REGION: 'us-east-1' })).toBe(
      'eu-west-2'
    )
  })

  it('falls back to the region the pasted block carried', () => {
    expect(resolveRegion(config({ region: '' }), { AWS_REGION: 'us-east-1' })).toBe('us-east-1')
    expect(resolveRegion(config({ region: '  ' }), { AWS_DEFAULT_REGION: 'sa-east-1' })).toBe(
      'sa-east-1'
    )
  })

  it('is undefined when nothing says where to look', () => {
    expect(resolveRegion(config({ region: '' }), {})).toBeUndefined()
  })
})

describe('parseDescribeInstances', () => {
  it('flattens reservations and reads the Name tag', () => {
    const { instances, truncated } = parseDescribeInstances(describeInstances([BASTION]))
    expect(truncated).toBe(false)
    expect(instances).toHaveLength(1)
    expect(instances[0]).toMatchObject({
      instanceId: 'i-0aaa1111bbbb2222c',
      name: 'prod-bastion',
      state: 'running',
      instanceType: 't3.micro',
      privateIpAddress: '10.0.2.11',
      publicIpAddress: '52.1.2.3',
      availabilityZone: 'eu-west-2a',
      vpcId: 'vpc-0123',
      platform: 'Linux/UNIX',
      ssmManaged: false
    })
  })

  it('copes with instances that have no tags or state', () => {
    const [instance] = parseDescribeInstances(
      describeInstances([{ InstanceId: 'i-0000000000000000a' }])
    ).instances
    expect(instance.name).toBeUndefined()
    expect(instance.state).toBe('unknown')
  })

  it('reads several instances out of one reservation', () => {
    const text = JSON.stringify({ Reservations: [{ Instances: [BASTION, APP_SERVER] }] })
    expect(parseDescribeInstances(text).instances.map((i) => i.instanceId)).toEqual([
      BASTION.InstanceId,
      APP_SERVER.InstanceId
    ])
  })

  it('reports a truncated listing', () => {
    expect(parseDescribeInstances(describeInstances([BASTION], { NextToken: 'more' })).truncated).toBe(
      true
    )
  })

  it('rejects a response that is not JSON', () => {
    expect(() => parseDescribeInstances('Unable to locate credentials')).toThrow(
      InstanceLookupError
    )
  })
})

describe('parseInstanceInformation', () => {
  it('keys reachability by instance id', () => {
    const { managed } = parseInstanceInformation(
      JSON.stringify({
        InstanceInformationList: [
          {
            InstanceId: 'i-0aaa1111bbbb2222c',
            PingStatus: 'Online',
            PlatformName: 'Amazon Linux',
            ComputerName: 'ip-10-0-2-11.eu-west-2.compute.internal',
            IPAddress: '10.0.2.11'
          }
        ]
      })
    )
    expect(managed.get('i-0aaa1111bbbb2222c')).toMatchObject({
      ssmManaged: true,
      ssmPingStatus: 'Online',
      privateIpAddress: '10.0.2.11'
    })
  })
})

describe('mergeInstances', () => {
  const ec2 = parseDescribeInstances(describeInstances([BASTION, APP_SERVER])).instances

  it('marks the instances Systems Manager can reach', () => {
    const { managed } = parseInstanceInformation(
      JSON.stringify({
        InstanceInformationList: [{ InstanceId: BASTION.InstanceId, PingStatus: 'Online' }]
      })
    )
    const merged = mergeInstances(ec2, managed)
    expect(merged.find((i) => i.instanceId === BASTION.InstanceId)).toMatchObject({
      ssmManaged: true,
      ssmPingStatus: 'Online',
      // EC2's description survives the merge.
      name: 'prod-bastion',
      state: 'running'
    })
    expect(merged.find((i) => i.instanceId === APP_SERVER.InstanceId)?.ssmManaged).toBe(false)
  })

  it('keeps managed instances EC2 never mentioned', () => {
    const { managed } = parseInstanceInformation(
      JSON.stringify({
        InstanceInformationList: [
          { InstanceId: 'mi-0999888877776666a', PingStatus: 'Online', Name: 'on-prem-jump' }
        ]
      })
    )
    const merged = mergeInstances(ec2, managed)
    expect(merged.map((i) => i.instanceId)).toContain('mi-0999888877776666a')
    expect(merged.find((i) => i.instanceId === 'mi-0999888877776666a')).toMatchObject({
      name: 'on-prem-jump',
      state: 'unknown',
      ssmManaged: true
    })
  })

  it('puts what a session could actually use first', () => {
    const instance = (overrides: Partial<SsmInstance>): SsmInstance => ({
      instanceId: 'i-0000000000000000a',
      state: 'running',
      ssmManaged: false,
      ...overrides
    })
    const ordered = sortInstances([
      instance({ instanceId: 'i-4', state: 'stopped' }),
      instance({ instanceId: 'i-3' }),
      instance({ instanceId: 'i-2', ssmManaged: true, ssmPingStatus: 'ConnectionLost' }),
      instance({ instanceId: 'i-1', ssmManaged: true, ssmPingStatus: 'Online' })
    ])
    expect(ordered.map((i) => i.instanceId)).toEqual(['i-1', 'i-2', 'i-3', 'i-4'])
  })

  it('sorts named instances before anonymous ones', () => {
    const ordered = sortInstances([
      { instanceId: 'i-b', state: 'running', ssmManaged: true, ssmPingStatus: 'Online' },
      {
        instanceId: 'i-a',
        name: 'zulu',
        state: 'running',
        ssmManaged: true,
        ssmPingStatus: 'Online'
      },
      {
        instanceId: 'i-c',
        name: 'alpha',
        state: 'running',
        ssmManaged: true,
        ssmPingStatus: 'Online'
      }
    ])
    expect(ordered.map((i) => i.instanceId)).toEqual(['i-c', 'i-a', 'i-b'])
  })
})

describe('classifyInstanceLookupFailure', () => {
  const cases: [string, RegExp][] = [
    ['spawn aws ENOENT', /AWS CLI was not found/],
    ['The security token included in the request is expired', /expired/i],
    ['Unable to locate credentials. You can configure credentials by running "aws configure".', /No AWS credentials/],
    ['An error occurred (UnauthorizedOperation) when calling the DescribeInstances operation', /Access denied by IAM/],
    ['You must specify a region. You can also configure your region by running "aws configure".', /Choose the region/],
    ['The config profile (nope) could not be found', /profile does not exist/]
  ]

  it.each(cases)('explains %s', (output, expected) => {
    expect(classifyInstanceLookupFailure(output, 255, 'ec2')).toMatch(expected)
  })

  it('names the action each lookup needs', () => {
    const denial = 'An error occurred (AccessDeniedException) when calling the operation'
    expect(classifyInstanceLookupFailure(denial, 254, 'ec2')).toContain('ec2:DescribeInstances')
    expect(classifyInstanceLookupFailure(denial, 254, 'ssm')).toContain(
      'ssm:DescribeInstanceInformation'
    )
  })

  it('falls back to the tail of whatever the CLI printed', () => {
    expect(classifyInstanceLookupFailure('something odd happened', 3, 'ec2')).toContain(
      'something odd happened'
    )
    expect(classifyInstanceLookupFailure('   ', 3, 'ec2')).toContain('without explaining why')
  })
})

describe('listSsmInstances', () => {
  const information = JSON.stringify({
    InstanceInformationList: [{ InstanceId: BASTION.InstanceId, PingStatus: 'Online' }]
  })

  it('merges both lookups into one list', async () => {
    const { run, calls } = runner({
      ec2: { stdout: describeInstances([BASTION, APP_SERVER]) },
      ssm: { stdout: information }
    })

    const result = await listSsmInstances(config(), { AWS_ACCESS_KEY_ID: 'ASIA' }, run)

    expect(result.region).toBe('eu-west-2')
    expect(result.warning).toBeUndefined()
    expect(result.instances.map((i) => i.instanceId)).toEqual([
      BASTION.InstanceId,
      APP_SERVER.InstanceId
    ])
    expect(result.instances[0].ssmManaged).toBe(true)
    // Both calls get the credentials, and neither shells out.
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.env.AWS_ACCESS_KEY_ID === 'ASIA')).toBe(true)
  })

  it('asks for a region before running anything, with pasted credentials', async () => {
    const { run, calls } = runner({})
    await expect(listSsmInstances(config({ region: '' }), {}, run)).rejects.toThrow(
      /Choose an AWS region/
    )
    expect(calls).toHaveLength(0)
  })

  it('lets the CLI resolve the region when it owns the credentials', async () => {
    const { run, calls } = runner({ ec2: { stdout: describeInstances([BASTION]) } })
    const result = await listSsmInstances(
      config({ region: '', credentialSource: 'cli', profile: 'prod' }),
      {},
      run
    )
    expect(result.region).toBeUndefined()
    expect(calls[0].args).not.toContain('--region')
    expect(result.instances).toHaveLength(1)
  })

  it('still lists what Systems Manager knows when EC2 is denied', async () => {
    const { run } = runner({
      ec2: {
        code: 254,
        stderr:
          'An error occurred (UnauthorizedOperation) when calling the DescribeInstances operation'
      },
      ssm: {
        stdout: JSON.stringify({
          InstanceInformationList: [
            { InstanceId: BASTION.InstanceId, PingStatus: 'Online', ComputerName: 'bastion' }
          ]
        })
      }
    })

    const result = await listSsmInstances(config(), {}, run)
    expect(result.instances.map((i) => i.instanceId)).toEqual([BASTION.InstanceId])
    expect(result.warning).toMatch(/Only Systems Manager could be listed/)
    expect(result.warning).toContain('ec2:DescribeInstances')
  })

  it('still lists EC2 when the reachability lookup is denied', async () => {
    const { run } = runner({
      ec2: { stdout: describeInstances([BASTION]) },
      ssm: { code: 254, stderr: 'An error occurred (AccessDeniedException)' }
    })

    const result = await listSsmInstances(config(), {}, run)
    expect(result.instances[0].ssmManaged).toBe(false)
    expect(result.warning).toMatch(/Reachability is unknown/)
  })

  it('fails only when neither lookup answered', async () => {
    const { run } = runner({
      ec2: { code: 253, stderr: 'The security token included in the request is expired' },
      ssm: { code: 253, stderr: 'The security token included in the request is expired' }
    })
    await expect(listSsmInstances(config(), {}, run)).rejects.toThrow(/expired/i)
  })

  it('treats an unreadable response as that lookup having failed', async () => {
    const { run } = runner({
      ec2: { stdout: '<html>proxy error</html>' },
      ssm: { stdout: information }
    })
    const result = await listSsmInstances(config(), {}, run)
    expect(result.instances.map((i) => i.instanceId)).toEqual([BASTION.InstanceId])
    expect(result.warning).toMatch(/Only Systems Manager could be listed/)
  })

  it('says so when the listing was cut short', async () => {
    const { run } = runner({
      ec2: { stdout: describeInstances([BASTION], { NextToken: 'more' }) },
      ssm: { stdout: information }
    })
    expect((await listSsmInstances(config(), {}, run)).warning).toMatch(/cut short at the first/)
  })

  it('returns an empty list rather than an error for an empty region', async () => {
    const { run } = runner({ ec2: { stdout: '{}' }, ssm: { stdout: '{}' } })
    const result = await listSsmInstances(config(), {}, run)
    expect(result.instances).toEqual([])
    expect(result.warning).toBeUndefined()
  })
})

/**
 * The same lookup driven through the real spawn path, against the stand-in CLI
 * in `test/fixtures/fake-aws.mjs`. The stand-in is a Node script with a
 * shebang, so this needs a POSIX shell to execute it.
 */
describe.runIf(process.platform !== 'win32')('listSsmInstances against a stand-in CLI', () => {
  const FAKE_CLI = join(__dirname, '../fixtures/fake-aws.mjs')

  afterEach(() => {
    delete process.env.FAKE_AWS_SCENARIO
    delete process.env.FAKE_AWS_REGION
  })

  it('reads the account and puts the reachable bastion first', async () => {
    const result = await listSsmInstances(config({ awsCliPath: FAKE_CLI }))

    expect(result.region).toBe('eu-west-2')
    expect(result.instances[0]).toMatchObject({
      name: 'prod-bastion',
      state: 'running',
      ssmManaged: true,
      ssmPingStatus: 'Online',
      privateIpAddress: '10.0.2.11'
    })
    // The one whose agent stopped answering is still offered, but marked.
    expect(result.instances[1]).toMatchObject({
      name: 'old-bastion',
      ssmManaged: true,
      ssmPingStatus: 'ConnectionLost'
    })
    // Everything Systems Manager cannot reach sorts below both.
    expect(result.instances.slice(2).every((instance) => !instance.ssmManaged)).toBe(true)
  })

  it('comes back empty for a region the fleet is not in', async () => {
    const result = await listSsmInstances(config({ awsCliPath: FAKE_CLI, region: 'us-east-1' }))
    expect(result.instances).toEqual([])
  })

  it('reports expired credentials as something to act on', async () => {
    process.env.FAKE_AWS_SCENARIO = 'expired'
    await expect(listSsmInstances(config({ awsCliPath: FAKE_CLI }))).rejects.toThrow(
      /credentials have expired/i
    )
  })

  it('degrades to the Systems Manager list when EC2 is denied', async () => {
    process.env.FAKE_AWS_SCENARIO = 'ec2-denied'
    const result = await listSsmInstances(config({ awsCliPath: FAKE_CLI }))
    expect(result.instances.map((instance) => instance.instanceId)).toEqual([
      'i-0ba5711000fee1dad',
      'i-0dead00beef001122'
    ])
    expect(result.warning).toContain('ec2:DescribeInstances')
  })

  it('says nothing about reachability when Systems Manager is denied', async () => {
    process.env.FAKE_AWS_SCENARIO = 'ssm-denied'
    const result = await listSsmInstances(config({ awsCliPath: FAKE_CLI }))
    expect(result.instances).toHaveLength(4)
    expect(result.instances.every((instance) => !instance.ssmManaged)).toBe(true)
    expect(result.warning).toMatch(/Reachability is unknown/)
  })

  it('explains a CLI that is not there', async () => {
    await expect(
      listSsmInstances(config({ awsCliPath: '/nonexistent/aws' }))
    ).rejects.toThrow(/AWS CLI was not found/)
  })
})
