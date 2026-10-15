/**
 * Parses the credential blocks the AWS access portal hands out.
 *
 * The "Command line or programmatic access" dialog offers the same temporary
 * credentials in several shapes depending on the shell you say you use, and
 * people paste whichever one they copied. All of them are accepted here so the
 * user never has to reformat anything:
 *
 *   export AWS_ACCESS_KEY_ID="ASIA…"        (bash/zsh)
 *   set AWS_ACCESS_KEY_ID=ASIA…             (cmd.exe)
 *   $Env:AWS_ACCESS_KEY_ID="ASIA…"          (PowerShell)
 *   [profile-name]                          (credentials-file stanza)
 *   aws_access_key_id = ASIA…
 *   AWS_ACCESS_KEY_ID=ASIA…                 (bare key=value)
 */

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  /** Present for temporary credentials, which is what the portal issues. */
  sessionToken?: string
  region?: string
  /** Only some sources include it; ISO-8601 when they do. */
  expiration?: string
}

export interface ParsedCredentials {
  credentials: AwsCredentials | null
  /** Populated when parsing failed, phrased for the user. */
  error?: string
  /** Keys that were recognised, for a "what did you paste" summary. */
  found: string[]
}

const KEY_ALIASES: Record<string, keyof AwsCredentials> = {
  aws_access_key_id: 'accessKeyId',
  aws_secret_access_key: 'secretAccessKey',
  aws_session_token: 'sessionToken',
  // The portal's older blocks use this name for the same thing.
  aws_security_token: 'sessionToken',
  aws_region: 'region',
  aws_default_region: 'region',
  region: 'region',
  aws_credential_expiration: 'expiration',
  aws_session_expiration: 'expiration'
}

/** Strips the shell prefix people copy along with the value. */
function stripAssignmentPrefix(line: string): string {
  return line
    .replace(/^\s*(?:export|set|setx|SET)\s+/i, '')
    .replace(/^\s*\$Env:/i, '')
    .replace(/^\s*\$env:/i, '')
    .trim()
}

function unquote(value: string): string {
  const trimmed = value.trim().replace(/[;,]\s*$/, '').trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Reads any of the supported formats out of pasted text. */
export function parseAwsCredentials(input: string): ParsedCredentials {
  const found: string[] = []
  if (!input || !input.trim()) {
    return { credentials: null, error: 'Paste the credentials block from the AWS access portal.', found }
  }

  const collected: Partial<AwsCredentials> = {}

  for (const rawLine of input.split(/\r?\n/)) {
    // Skip comments and the [profile] header of a credentials-file stanza.
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//') || /^\[.*\]$/.test(line)) continue

    const assignment = stripAssignmentPrefix(line)
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(assignment)
    if (!match) continue

    const key = match[1].toLowerCase()
    const target = KEY_ALIASES[key]
    if (!target) continue

    const value = unquote(match[2])
    if (!value) continue

    collected[target] = value
    if (!found.includes(target)) found.push(target)
  }

  if (!collected.accessKeyId && !collected.secretAccessKey) {
    return {
      credentials: null,
      error:
        'No AWS keys found in that text. Paste the block from the access portal — the one with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.',
      found
    }
  }
  if (!collected.accessKeyId) {
    return { credentials: null, error: 'AWS_ACCESS_KEY_ID is missing from that block.', found }
  }
  if (!collected.secretAccessKey) {
    return { credentials: null, error: 'AWS_SECRET_ACCESS_KEY is missing from that block.', found }
  }

  return {
    credentials: {
      accessKeyId: collected.accessKeyId,
      secretAccessKey: collected.secretAccessKey,
      sessionToken: collected.sessionToken,
      region: collected.region,
      expiration: collected.expiration
    },
    found
  }
}

/** The environment an AWS CLI child needs to use these credentials. */
export function credentialsToEnv(credentials: AwsCredentials): Record<string, string> {
  const env: Record<string, string> = {
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey
  }
  if (credentials.sessionToken) env.AWS_SESSION_TOKEN = credentials.sessionToken
  if (credentials.region) {
    env.AWS_REGION = credentials.region
    env.AWS_DEFAULT_REGION = credentials.region
  }
  return env
}

/** `ASIA****************WXYZ` — safe to show in the UI and in logs. */
export function maskAccessKeyId(accessKeyId: string): string {
  if (accessKeyId.length <= 8) return '*'.repeat(accessKeyId.length)
  return `${accessKeyId.slice(0, 4)}${'*'.repeat(accessKeyId.length - 8)}${accessKeyId.slice(-4)}`
}

/**
 * Temporary keys start with ASIA; long-lived IAM user keys start with AKIA.
 * Worth telling the two apart, because only one of them expires.
 */
export function isTemporary(credentials: AwsCredentials): boolean {
  return Boolean(credentials.sessionToken) || credentials.accessKeyId.startsWith('ASIA')
}

export function expiresAt(credentials: AwsCredentials): Date | null {
  if (!credentials.expiration) return null
  const date = new Date(credentials.expiration)
  return Number.isNaN(date.getTime()) ? null : date
}

export function isExpired(credentials: AwsCredentials, now = new Date()): boolean {
  const expiry = expiresAt(credentials)
  return expiry ? expiry.getTime() <= now.getTime() : false
}

/**
 * The credential block on the clipboard, or why there is not one.
 *
 * The main process reads the clipboard and only this crosses to the window:
 * a paste button that handed over whatever was copied would put someone's
 * password on screen in a box labelled "AWS credentials" the first time they
 * clicked it with the wrong thing copied.
 */
export function credentialsFromClipboard(text: string): string {
  const block = text.trim()
  if (!block) {
    throw new Error('The clipboard is empty. Copy the block from the AWS access portal first.')
  }
  const parsed = parseAwsCredentials(block)
  if (parsed.credentials) return block
  // A block missing one line is worth naming; anything else is just not one.
  if (parsed.found.length > 0 && parsed.error) throw new Error(parsed.error)
  throw new Error(
    'The clipboard does not hold AWS credentials. Copy the block with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the access portal, then paste again.'
  )
}

export interface CredentialBlockCheck {
  credentials: AwsCredentials | null
  /** What is wrong with it, phrased for the box it was pasted into. */
  error?: string
}

/**
 * What can be said about a block as it is pasted: nothing yet, what is wrong
 * with it, or the credentials it holds.
 *
 * A block that has already run out is the easy mistake — the tab copied from
 * an hour ago — so it is turned down here rather than at connect time.
 */
export function checkCredentialBlock(text: string, now = new Date()): CredentialBlockCheck {
  if (!text.trim()) return { credentials: null }
  const parsed = parseAwsCredentials(text)
  if (!parsed.credentials) {
    return { credentials: null, error: parsed.error ?? 'That block could not be read' }
  }
  if (isExpired(parsed.credentials, now)) {
    return {
      credentials: parsed.credentials,
      error: 'That block has already expired — copy a fresh one'
    }
  }
  return { credentials: parsed.credentials }
}

/**
 * `ASIA************MPLE · eu-west-2 · temporary` — a pasted block described
 * the way it will be once saved, with nothing secret in it.
 */
export function describeCredentials(
  credentials: AwsCredentials,
  formatTime: (date: Date) => string = (date) => date.toLocaleTimeString()
): string {
  const parts = [maskAccessKeyId(credentials.accessKeyId)]
  if (credentials.region) parts.push(credentials.region)
  const expiry = expiresAt(credentials)
  if (expiry) parts.push(`expires ${formatTime(expiry)}`)
  else if (isTemporary(credentials)) parts.push('temporary')
  return parts.join(' · ')
}
