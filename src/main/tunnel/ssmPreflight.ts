/**
 * Answers "will an SSM session actually work from this machine?" before the
 * user tries to connect.
 *
 * Nearly every SSM failure is one of three things: no AWS CLI, no Session
 * Manager plugin, or credentials that have quietly expired. Checking them
 * up front turns a confusing connection error into a specific instruction.
 */
import { execFile } from 'node:child_process'
import type { SsmConfig } from '../../shared/types'

export interface CheckResult {
  ok: boolean
  detail?: string
  error?: string
}

export interface SsmPreflight {
  awsCli: CheckResult
  plugin: CheckResult
  /** `ssoExpired` when signing in to AWS SSO again would fix it. */
  credentials: CheckResult & { ssoExpired?: boolean }
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', ...extraEnv }
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((error as unknown as { code: number }).code)
            : error
              ? null
              : 0
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') + (error && code === null ? `\n${error.message}` : '')
        })
      }
    )
  })
}

export async function checkSsmPrerequisites(
  config: SsmConfig,
  credentialEnv: Record<string, string> = {}
): Promise<SsmPreflight> {
  const cli = config.awsCliPath?.trim() || 'aws'

  const awsVersion = await run(cli, ['--version'], 10000)
  const awsOk = awsVersion.code === 0
  const versionText = `${awsVersion.stdout} ${awsVersion.stderr}`.trim().split('\n')[0]

  const result: SsmPreflight = {
    awsCli: awsOk
      ? { ok: true, detail: versionText }
      : {
          ok: false,
          error:
            'The AWS CLI could not be run. Install AWS CLI v2, or set an explicit path below.'
        },
    plugin: { ok: false },
    credentials: { ok: false }
  }

  // The plugin is a separate binary the CLI shells out to; `--version` is the
  // cheapest way to confirm it is on PATH.
  const plugin = await run('session-manager-plugin', ['--version'], 10000)
  result.plugin =
    plugin.code === 0
      ? { ok: true, detail: plugin.stdout.trim() || 'installed' }
      : {
          ok: false,
          error:
            'The Session Manager plugin is not installed. Without it, port forwarding cannot start.'
        }

  if (!awsOk) {
    result.credentials = { ok: false, error: 'Skipped — the AWS CLI is not available.' }
    return result
  }

  const args = ['sts', 'get-caller-identity', '--output', 'json']
  // With pasted credentials a --profile would send the CLI looking elsewhere.
  const usingPasted = Object.keys(credentialEnv).length > 0
  if (!usingPasted && config.profile?.trim()) args.push('--profile', config.profile.trim())
  if (config.region?.trim()) args.push('--region', config.region.trim())

  const identity = await run(cli, args, 20000, credentialEnv)
  if (identity.code === 0) {
    try {
      const parsed = JSON.parse(identity.stdout) as { Account?: string; Arn?: string }
      result.credentials = {
        ok: true,
        detail: parsed.Arn ? `${parsed.Arn} (account ${parsed.Account ?? '?'})` : 'valid'
      }
    } catch {
      result.credentials = { ok: true, detail: 'valid' }
    }
  } else {
    const text = `${identity.stderr} ${identity.stdout}`.toLowerCase()
    // An SSO session the CLI could not refresh is fixed by signing in again,
    // which the form offers to do; pasted credentials have no session to renew.
    const ssoExpired = !usingPasted && /\bsso\b|token has expired/.test(text)
    result.credentials = {
      ok: false,
      ...(ssoExpired ? { ssoExpired: true } : {}),
      error: /expired|sso/.test(text)
        ? 'Credentials have expired. For SSO run: aws sso login --profile <name>'
        : /profile/.test(text)
          ? 'That AWS profile was not found in your AWS config.'
          : 'Could not verify credentials for this profile.'
    }
  }

  return result
}
