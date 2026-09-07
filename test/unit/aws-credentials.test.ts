import { describe, expect, it } from 'vitest'
import {
  credentialsToEnv,
  expiresAt,
  isExpired,
  isTemporary,
  maskAccessKeyId,
  parseAwsCredentials
} from '../../src/shared/aws/credentials'

const KEY = 'ASIAIOSFODNN7EXAMPLE'
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const TOKEN = 'IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD'

describe('parseAwsCredentials', () => {
  it('parses the bash export block the portal gives you', () => {
    const { credentials } = parseAwsCredentials(`
export AWS_ACCESS_KEY_ID="${KEY}"
export AWS_SECRET_ACCESS_KEY="${SECRET}"
export AWS_SESSION_TOKEN="${TOKEN}"
`)
    expect(credentials).toEqual({
      accessKeyId: KEY,
      secretAccessKey: SECRET,
      sessionToken: TOKEN,
      region: undefined,
      expiration: undefined
    })
  })

  it('parses the Windows cmd.exe block', () => {
    const { credentials } = parseAwsCredentials(`
set AWS_ACCESS_KEY_ID=${KEY}
set AWS_SECRET_ACCESS_KEY=${SECRET}
set AWS_SESSION_TOKEN=${TOKEN}
`)
    expect(credentials?.accessKeyId).toBe(KEY)
    expect(credentials?.sessionToken).toBe(TOKEN)
  })

  it('parses the PowerShell block', () => {
    const { credentials } = parseAwsCredentials(`
$Env:AWS_ACCESS_KEY_ID="${KEY}"
$Env:AWS_SECRET_ACCESS_KEY="${SECRET}"
$Env:AWS_SESSION_TOKEN="${TOKEN}"
`)
    expect(credentials?.accessKeyId).toBe(KEY)
    expect(credentials?.secretAccessKey).toBe(SECRET)
  })

  it('parses a credentials-file stanza, ignoring the profile header', () => {
    const { credentials } = parseAwsCredentials(`
[111122223333_AdministratorAccess]
aws_access_key_id = ${KEY}
aws_secret_access_key = ${SECRET}
aws_session_token = ${TOKEN}
region = eu-west-2
`)
    expect(credentials?.accessKeyId).toBe(KEY)
    expect(credentials?.region).toBe('eu-west-2')
  })

  it('parses bare key=value lines', () => {
    const { credentials } = parseAwsCredentials(
      `AWS_ACCESS_KEY_ID=${KEY}\nAWS_SECRET_ACCESS_KEY=${SECRET}`
    )
    expect(credentials?.accessKeyId).toBe(KEY)
  })

  it('accepts the older AWS_SECURITY_TOKEN spelling', () => {
    const { credentials } = parseAwsCredentials(
      `AWS_ACCESS_KEY_ID=${KEY}\nAWS_SECRET_ACCESS_KEY=${SECRET}\nAWS_SECURITY_TOKEN=${TOKEN}`
    )
    expect(credentials?.sessionToken).toBe(TOKEN)
  })

  it('picks up the region from either spelling', () => {
    const a = parseAwsCredentials(
      `AWS_ACCESS_KEY_ID=${KEY}\nAWS_SECRET_ACCESS_KEY=${SECRET}\nAWS_DEFAULT_REGION=us-east-1`
    )
    expect(a.credentials?.region).toBe('us-east-1')

    const b = parseAwsCredentials(
      `AWS_ACCESS_KEY_ID=${KEY}\nAWS_SECRET_ACCESS_KEY=${SECRET}\nAWS_REGION=ap-south-1`
    )
    expect(b.credentials?.region).toBe('ap-south-1')
  })

  it('survives the mess of a real paste', () => {
    const { credentials } = parseAwsCredentials(`
# copied from the portal

  export AWS_ACCESS_KEY_ID='${KEY}';
  export AWS_SECRET_ACCESS_KEY='${SECRET}' ;

export AWS_SESSION_TOKEN="${TOKEN}"

`)
    expect(credentials?.accessKeyId).toBe(KEY)
    expect(credentials?.secretAccessKey).toBe(SECRET)
    expect(credentials?.sessionToken).toBe(TOKEN)
  })

  it('keeps base64 padding and slashes in the token intact', () => {
    const padded = `${TOKEN}abc/def+ghi==`
    const { credentials } = parseAwsCredentials(
      `AWS_ACCESS_KEY_ID=${KEY}\nAWS_SECRET_ACCESS_KEY=${SECRET}\nAWS_SESSION_TOKEN=${padded}`
    )
    expect(credentials?.sessionToken).toBe(padded)
  })

  it('reports which keys it recognised', () => {
    const { found } = parseAwsCredentials(
      `AWS_ACCESS_KEY_ID=${KEY}\nAWS_SECRET_ACCESS_KEY=${SECRET}\nAWS_SESSION_TOKEN=${TOKEN}`
    )
    expect(found).toEqual(['accessKeyId', 'secretAccessKey', 'sessionToken'])
  })

  it('explains what is missing rather than failing silently', () => {
    expect(parseAwsCredentials('').error).toMatch(/Paste the credentials block/)
    expect(parseAwsCredentials('just some words').error).toMatch(/No AWS keys found/)
    expect(parseAwsCredentials(`AWS_ACCESS_KEY_ID=${KEY}`).error).toMatch(
      /AWS_SECRET_ACCESS_KEY is missing/
    )
    expect(parseAwsCredentials(`AWS_SECRET_ACCESS_KEY=${SECRET}`).error).toMatch(
      /AWS_ACCESS_KEY_ID is missing/
    )
  })

  it('ignores unrelated variables in the same paste', () => {
    const { credentials } = parseAwsCredentials(
      `export PATH=/usr/bin\nexport AWS_ACCESS_KEY_ID=${KEY}\nexport AWS_SECRET_ACCESS_KEY=${SECRET}\nexport EDITOR=vim`
    )
    expect(credentials?.accessKeyId).toBe(KEY)
  })
})

describe('credentialsToEnv', () => {
  it('produces the variables the AWS CLI reads', () => {
    expect(
      credentialsToEnv({ accessKeyId: KEY, secretAccessKey: SECRET, sessionToken: TOKEN })
    ).toEqual({
      AWS_ACCESS_KEY_ID: KEY,
      AWS_SECRET_ACCESS_KEY: SECRET,
      AWS_SESSION_TOKEN: TOKEN
    })
  })

  it('omits the session token for long-lived keys', () => {
    const env = credentialsToEnv({ accessKeyId: 'AKIA123', secretAccessKey: SECRET })
    expect(env.AWS_SESSION_TOKEN).toBeUndefined()
  })

  it('sets both region variables when a region is known', () => {
    const env = credentialsToEnv({
      accessKeyId: KEY,
      secretAccessKey: SECRET,
      region: 'eu-west-2'
    })
    expect(env.AWS_REGION).toBe('eu-west-2')
    expect(env.AWS_DEFAULT_REGION).toBe('eu-west-2')
  })
})

describe('credential metadata', () => {
  it('masks the access key for display', () => {
    expect(maskAccessKeyId(KEY)).toBe('ASIA************MPLE')
    expect(maskAccessKeyId(KEY)).not.toContain('IOSFODNN7EXA')
    expect(maskAccessKeyId('short')).toBe('*****')
  })

  it('tells temporary credentials from long-lived ones', () => {
    expect(isTemporary({ accessKeyId: KEY, secretAccessKey: SECRET, sessionToken: TOKEN })).toBe(true)
    expect(isTemporary({ accessKeyId: 'ASIAX', secretAccessKey: SECRET })).toBe(true)
    expect(isTemporary({ accessKeyId: 'AKIAX', secretAccessKey: SECRET })).toBe(false)
  })

  it('reads an expiry when the block carries one', () => {
    const credentials = {
      accessKeyId: KEY,
      secretAccessKey: SECRET,
      expiration: '2030-01-01T00:00:00Z'
    }
    expect(expiresAt(credentials)?.toISOString()).toBe('2030-01-01T00:00:00.000Z')
    expect(isExpired(credentials, new Date('2029-01-01'))).toBe(false)
    expect(isExpired(credentials, new Date('2031-01-01'))).toBe(true)
  })

  it('treats an unknown expiry as not expired', () => {
    expect(isExpired({ accessKeyId: KEY, secretAccessKey: SECRET })).toBe(false)
    expect(expiresAt({ accessKeyId: KEY, secretAccessKey: SECRET })).toBeNull()
  })
})
