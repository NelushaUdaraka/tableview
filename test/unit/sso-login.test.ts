/**
 * Signing in to AWS SSO from the app: the command, reading what the CLI asks
 * the user to open, falling back to a code when no browser opens, and
 * cancelling — against the stand-in for the AWS CLI.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SsoLogin,
  SsoLoginCancelled,
  buildSsoLoginCommand,
  classifySsoLoginFailure,
  parseSsoPrompt
} from '../../src/main/tunnel/ssoLogin'
import type { SsoLoginPrompt } from '../../src/shared/ipc'
import { DEFAULT_SSM_CONFIG } from '../../src/shared/types'

const FAKE_CLI = join(__dirname, '../fixtures/fake-aws.mjs')

describe('buildSsoLoginCommand', () => {
  it('signs in for the profile without opening a browser itself', () => {
    expect(buildSsoLoginCommand({ profile: ' dev ' }, false)).toMatchObject({
      command: 'aws',
      args: ['sso', 'login', '--no-browser', '--profile', 'dev']
    })
  })

  it('asks for a code when told to, and honours the CLI path', () => {
    expect(buildSsoLoginCommand({ awsCliPath: '/opt/aws', profile: '' }, true)).toMatchObject({
      command: '/opt/aws',
      args: ['sso', 'login', '--no-browser', '--use-device-code']
    })
  })
})

describe('parseSsoPrompt', () => {
  it('reads the browser flow’s page', () => {
    expect(
      parseSsoPrompt(
        'Browser will not be automatically opened.\nPlease visit the following URL:\n\nhttps://oidc.eu-west-2.amazonaws.com/authorize?a=1&b=2\n'
      )
    ).toEqual({
      url: 'https://oidc.eu-west-2.amazonaws.com/authorize?a=1&b=2',
      code: null,
      openUrl: 'https://oidc.eu-west-2.amazonaws.com/authorize?a=1&b=2'
    })
  })

  it('reads the device flow’s page and code, opening the page with the code filled in', () => {
    const output =
      'Please visit the following URL:\n\nhttps://device.sso.eu-west-2.amazonaws.com/\n\nThen enter the code:\n\nWDDD-HRQV\n\n' +
      'Alternatively, you may visit the following URL which will autofill the code upon loading:\nhttps://device.sso.eu-west-2.amazonaws.com/?user_code=WDDD-HRQV\n'
    expect(parseSsoPrompt(output)).toEqual({
      url: 'https://device.sso.eu-west-2.amazonaws.com/',
      code: 'WDDD-HRQV',
      openUrl: 'https://device.sso.eu-west-2.amazonaws.com/?user_code=WDDD-HRQV'
    })
  })

  it('waits for the code when the page has come but the code has not', () => {
    expect(parseSsoPrompt('Please visit:\n\nhttps://device.sso.x/\n\nThen enter the code:\n\n')).toBeNull()
    expect(parseSsoPrompt('Attempting to sign in')).toBeNull()
  })
})

describe('classifySsoLoginFailure', () => {
  it('says what to do about the usual failures', () => {
    expect(classifySsoLoginFailure('spawn aws ENOENT')).toMatch(/AWS CLI was not found/)
    expect(classifySsoLoginFailure('The config profile (nope) could not be found')).toMatch(/profile does not exist/)
    expect(
      classifySsoLoginFailure('Missing the following required SSO configuration values: sso_start_url')
    ).toMatch(/aws configure sso/)
    expect(classifySsoLoginFailure('Unknown options: --use-device-code')).toMatch(/too old/)
    expect(classifySsoLoginFailure('something odd\nfinal words\n')).toBe(
      'Signing in with AWS SSO failed: final words'
    )
  })
})

describe('SsoLogin', () => {
  const token = join(tmpdir(), `fake-aws-sso-${process.pid}`)
  const argsFile = join(tmpdir(), `fake-aws-sso-args-${process.pid}.json`)
  const fakeSpawn = ((command: string, args: string[], options: object) =>
    spawn(command, [FAKE_CLI, ...args], options)) as never

  beforeEach(() => {
    rmSync(token, { force: true })
    process.env.FAKE_AWS_SSO_TOKEN_FILE = token
    process.env.FAKE_AWS_SSO_DELAY = '300'
    process.env.FAKE_AWS_ARGS_FILE = argsFile
    delete process.env.FAKE_AWS_SCENARIO
  })
  afterEach(() => {
    rmSync(token, { force: true })
    rmSync(argsFile, { force: true })
    delete process.env.FAKE_AWS_SSO_TOKEN_FILE
    delete process.env.FAKE_AWS_SSO_DELAY
    delete process.env.FAKE_AWS_ARGS_FILE
  })

  const lastArgs = (): string[] => JSON.parse(readFileSync(argsFile, 'utf8')).args

  function login(openUrl: (url: string) => Promise<void>): { login: SsoLogin; prompts: SsoLoginPrompt[]; opened: string[] } {
    const prompts: SsoLoginPrompt[] = []
    const opened: string[] = []
    const instance = new SsoLogin(
      { awsCliPath: process.execPath, profile: 'dev' },
      {
        openUrl: (url) => {
          opened.push(url)
          return openUrl(url)
        },
        onPrompt: (prompt) => prompts.push(prompt),
        spawnFn: fakeSpawn
      }
    )
    return { login: instance, prompts, opened }
  }

  it('opens the page in the browser and resolves once the sign-in is done', async () => {
    const { login: instance, prompts, opened } = login(async () => undefined)
    await instance.run()
    expect(existsSync(token)).toBe(true)
    expect(opened).toEqual([expect.stringContaining('https://oidc.eu-west-2.amazonaws.com/authorize')])
    expect(prompts).toEqual([expect.objectContaining({ code: null })])
    expect(lastArgs()).toEqual(['sso', 'login', '--no-browser', '--profile', 'dev'])
  })

  it('starts again with a code when no browser can be opened', async () => {
    const { login: instance, prompts, opened } = login(async (url) => {
      if (url.includes('authorize')) throw new Error('no browser')
    })
    await instance.run()
    expect(existsSync(token)).toBe(true)
    expect(lastArgs()).toContain('--use-device-code')
    expect(prompts).toEqual([
      {
        url: 'https://device.sso.eu-west-2.amazonaws.com/',
        code: 'WDDD-HRQV',
        openUrl: 'https://device.sso.eu-west-2.amazonaws.com/?user_code=WDDD-HRQV'
      }
    ])
    expect(opened).toHaveLength(2)
  })

  it('shows the code even when no browser opens for it', async () => {
    const { login: instance, prompts } = login(async () => {
      throw new Error('no browser')
    })
    await instance.run(true)
    expect(prompts.map((p) => p.code)).toEqual(['WDDD-HRQV'])
  })

  it('rejects with what went wrong', async () => {
    process.env.FAKE_AWS_SCENARIO = 'sso-not-configured'
    const { login: instance } = login(async () => undefined)
    await expect(instance.run()).rejects.toThrow(/aws configure sso/)
  })

  it('says the CLI is missing when its path leads nowhere', async () => {
    const instance = new SsoLogin(
      { awsCliPath: join(tmpdir(), 'no-such-aws-cli'), profile: 'dev' },
      { openUrl: async () => undefined, onPrompt: () => undefined }
    )
    await expect(instance.run()).rejects.toThrow(/AWS CLI was not found/)
  })

  it('stops the CLI on cancel and rejects as cancelled', async () => {
    process.env.FAKE_AWS_SSO_DELAY = '20000'
    const { login: instance, prompts } = login(async () => undefined)
    const running = instance.run()
    while (prompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 20))
    await instance.cancel()
    await expect(running).rejects.toBeInstanceOf(SsoLoginCancelled)
    expect(existsSync(token)).toBe(false)
  })
})

describe('the prerequisite check', () => {
  afterEach(() => {
    delete process.env.FAKE_AWS_SCENARIO
  })

  it('says when signing in to AWS SSO again would fix the credentials', async () => {
    const { checkSsmPrerequisites } = await import('../../src/main/tunnel/ssmPreflight')
    const cli = { ...DEFAULT_SSM_CONFIG, awsCliPath: FAKE_CLI, profile: 'dev' }

    process.env.FAKE_AWS_SCENARIO = 'sso-expired'
    const expired = await checkSsmPrerequisites(cli)
    expect(expired.awsCli.ok).toBe(true)
    expect(expired.credentials).toMatchObject({ ok: false, ssoExpired: true })

    // Pasted credentials have no SSO session to renew.
    const pasted = await checkSsmPrerequisites(cli, { AWS_ACCESS_KEY_ID: 'ASIAEXAMPLE' })
    expect(pasted.credentials.ok).toBe(false)
    expect(pasted.credentials.ssoExpired).toBeUndefined()

    process.env.FAKE_AWS_SCENARIO = 'ok'
    expect((await checkSsmPrerequisites(cli)).credentials).toMatchObject({ ok: true })
  })
})
