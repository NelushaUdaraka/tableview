/**
 * Signing in to AWS SSO (IAM Identity Center) for a connection whose
 * credentials the CLI resolves, when that session has expired.
 *
 * Runs `aws sso login --profile <name> --no-browser` and opens the page it
 * prints in the user's browser itself: the CLI needs no stdin for this, only
 * someone to finish signing in, and opening the page from here is how the app
 * learns whether a browser could be opened at all. When one cannot, the login
 * starts again with `--use-device-code`, whose page and code work from any
 * device, and both are shown in the app. The CLI exits once the sign-in is
 * finished (or has failed), and its token cache is what the next session reads.
 */
import { ChildProcess, spawn } from 'node:child_process'
import type { SsmConfig } from '../../shared/types'
import type { SsoLoginPrompt } from '../../shared/ipc'
import { stopProcessTree } from './processTree'

export type SsoLoginConfig = Pick<SsmConfig, 'awsCliPath' | 'profile'>

export class SsoLoginCancelled extends Error {
  constructor() {
    super('Signing in was cancelled')
    this.name = 'SsoLoginCancelled'
  }
}

export function buildSsoLoginCommand(
  config: SsoLoginConfig,
  deviceCode: boolean
): { command: string; args: string[]; env: Record<string, string> } {
  const args = ['sso', 'login', '--no-browser']
  if (config.profile?.trim()) args.push('--profile', config.profile.trim())
  if (deviceCode) args.push('--use-device-code')
  return {
    command: config.awsCliPath?.trim() || 'aws',
    args,
    env: { AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' }
  }
}

const URL_PATTERN = /https:\/\/[^\s"'<>]+/g
/** The device flow's user code, e.g. `ABCD-EFGH`, on the line after "enter the code". */
const CODE_PATTERN = /enter the code:\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)/i

/**
 * What the CLI asks the user to open, once it has said it.
 *
 * The device flow prints the verification page, the code, and a second page
 * with the code already filled in, which is the one to open; the browser
 * (PKCE) flow prints a single page to open on this machine.
 */
export function parseSsoPrompt(output: string): SsoLoginPrompt | null {
  const urls = [...output.matchAll(URL_PATTERN)].map((match) => match[0].replace(/[.,;)]+$/, ''))
  if (urls.length === 0) return null
  const code = CODE_PATTERN.exec(output)?.[1] ?? null
  // The device flow prints the code after its page; wait for it.
  if (/enter the code/i.test(output) && !code) return null
  const filled = code ? urls.find((url) => /user_code=/i.test(url)) : undefined
  return { url: urls[0], code, openUrl: filled ?? urls[0] }
}

/** The CLI's failure, said as what to do about it. */
export function classifySsoLoginFailure(output: string): string {
  const text = output.toLowerCase()
  if (/enoent|is not recognized as an internal|command not found/.test(text)) {
    return 'The AWS CLI was not found. Install AWS CLI v2, or set an explicit path in the connection settings.'
  }
  if (/unknown options?:.*(--no-browser|--use-device-code)|invalid choice: 'sso'/.test(text)) {
    return 'This AWS CLI is too old to sign in from TableView. Update to the latest AWS CLI v2, or run aws sso login yourself.'
  }
  if (/profile.*could not be found|profile.*not found/.test(text)) {
    return 'That AWS profile does not exist in your AWS config.'
  }
  if (/missing the following required sso configuration|sso_start_url|sso_session/.test(text)) {
    return 'That profile is not set up for AWS SSO: it has no sso_session or sso_start_url. Run aws configure sso for it first.'
  }
  if (/expired|timed out|authorizationpendingexception/.test(text)) {
    return 'The sign-in was not finished in time. Try again, and finish it in the browser.'
  }
  if (/access ?denied|accessdeniedexception/.test(text)) {
    return 'The sign-in was refused. Check that you signed in as someone with access to this account.'
  }
  const last = output.trim().split('\n').filter(Boolean).pop()
  return last ? `Signing in with AWS SSO failed: ${last.trim()}` : 'Signing in with AWS SSO failed.'
}

export interface SsoLoginDeps {
  /** Opens a page in the user's browser; rejects when no browser could be opened. */
  openUrl: (url: string) => Promise<void>
  /** Told what the user is asked to open (and the code to enter, for the device flow). */
  onPrompt: (prompt: SsoLoginPrompt) => void
  /** Injected so tests can drive a stand-in for the AWS CLI. */
  spawnFn?: typeof spawn
}

export class SsoLogin {
  private child: ChildProcess | null = null
  private cancelled = false

  constructor(
    private readonly config: SsoLoginConfig,
    private readonly deps: SsoLoginDeps
  ) {}

  /**
   * Resolves once the CLI says the sign-in is done; rejects with what went
   * wrong, or with `SsoLoginCancelled` after `cancel()`.
   */
  async run(deviceCode = false): Promise<void> {
    const outcome = await this.attempt(deviceCode)
    // No browser to finish the sign-in in: a code works from any device.
    if (outcome === 'no-browser' && !this.cancelled) await this.attempt(true)
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    if (this.child) await stopProcessTree(this.child)
  }

  private attempt(deviceCode: boolean): Promise<'done' | 'no-browser'> {
    if (this.cancelled) return Promise.reject(new SsoLoginCancelled())
    const { command, args, env } = buildSsoLoginCommand(this.config, deviceCode)
    const child = (this.deps.spawnFn ?? spawn)(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    })
    this.child = child

    return new Promise((resolve, reject) => {
      let output = ''
      let prompted = false
      let noBrowser = false

      const record = (chunk: Buffer): void => {
        output += chunk.toString()
        if (output.length > 64_000) output = output.slice(-32_000)
        if (prompted) return
        const prompt = parseSsoPrompt(output)
        if (!prompt) return
        prompted = true
        if (prompt.code) {
          // The code is the way in whether or not a browser opens here.
          this.deps.onPrompt(prompt)
          this.deps.openUrl(prompt.openUrl).catch(() => undefined)
          return
        }
        this.deps.openUrl(prompt.openUrl).then(
          () => this.deps.onPrompt(prompt),
          () => {
            noBrowser = true
            void stopProcessTree(child)
          }
        )
      }
      child.stdout?.on('data', record)
      child.stderr?.on('data', record)

      child.once('error', (error) => {
        output += `\n${error.message}`
      })
      child.once('close', (code) => {
        if (this.child === child) this.child = null
        if (this.cancelled) reject(new SsoLoginCancelled())
        else if (noBrowser) resolve('no-browser')
        else if (code === 0) resolve('done')
        else reject(new Error(classifySsoLoginFailure(output)))
      })
    })
  }
}
