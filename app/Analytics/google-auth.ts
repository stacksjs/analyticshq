/**
 * Service-account auth for the Google APIs we read from (#25, #13 follow-up).
 *
 * Extracted from ga4.ts when Search Console became the second caller. One
 * implementation, because the alternative is two JWT signers that agree until
 * the day one is fixed — and the failure mode of a subtly wrong assertion is a
 * 401 from Google with no clue which half is at fault.
 *
 * ## Service accounts, NOT OAuth, and that is a product decision
 *
 * OAuth would need us to register an application with Google, run a consent
 * screen, pass verification for sensitive scopes, and hold refresh tokens for
 * our customers' Google accounts. That is a standing dependency on Google and a
 * pile of long-lived credentials, for a product whose entire pitch is not being
 * that.
 *
 * With a service account the customer creates the credential inside their OWN
 * Google Cloud project and grants its email read access to the property they
 * want imported. We register nothing with Google, and the key is used for one
 * token exchange and dropped — never written to the database, never logged,
 * never included in an error message (see `redactKey`).
 *
 * This is what let #25 ship without first answering the "do we take a Google
 * dependency" question it was blocked on: the answer is that we do not have to.
 *
 * ## The scope is the caller's, and it is always read-only
 *
 * `buildAssertion` takes the scope rather than hardcoding one, so adding an API
 * means naming its read scope at the call site instead of editing the signer.
 * Every scope in the codebase ends in `.readonly`, and a test asserts it: a
 * service account with write access to someone's analytics property is not
 * something an importer should ever ask for.
 */
import { createSign } from 'node:crypto'

export interface ServiceAccountKey {
  client_email: string
  private_key: string
  token_uri?: string
}

/** Overridable so a harness can stand in for Google's token endpoint. */
export const TOKEN_URL = (): string => process.env.GOOGLE_TOKEN_URL || process.env.GA4_TOKEN_URL || 'https://oauth2.googleapis.com/token'

/**
 * Parse and validate a service-account JSON key.
 *
 * Returns a plain error string rather than throwing, because every caller — the
 * CLIs and the HTTP endpoints — has to show it to a person, and a stack trace
 * from JSON.parse is not an explanation. The message never quotes the input:
 * the input is a private key.
 */
export function parseServiceAccountKey(json: string): { key: ServiceAccountKey } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  }
  catch {
    return { error: 'That is not valid JSON. Paste the whole service-account key file, including the outer braces.' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { error: 'The key should be a JSON object.' }
  const obj = parsed as Record<string, unknown>

  // An OAuth *client* secret is a different file that people reach for by
  // mistake; it has `installed`/`web` at the top level and no private_key.
  if (!obj.private_key && (obj.installed || obj.web))
    return { error: 'That looks like an OAuth client secret, not a service-account key. Create a service account and download its JSON key.' }
  if (typeof obj.client_email !== 'string' || !obj.client_email.includes('@'))
    return { error: 'The key has no client_email. Download the JSON key for a service account, not an API key.' }
  if (typeof obj.private_key !== 'string' || !obj.private_key.includes('PRIVATE KEY'))
    return { error: 'The key has no private_key. Download the JSON key for a service account, not an API key.' }

  return {
    key: {
      client_email: obj.client_email,
      private_key: obj.private_key,
      token_uri: typeof obj.token_uri === 'string' ? obj.token_uri : undefined,
    },
  }
}

/**
 * Strip anything key-shaped out of text bound for a log or an HTTP response.
 *
 * Google's token endpoint echoes parts of a malformed assertion back in its
 * error body, so "just don't log the key" is not sufficient on its own — the
 * error path is exactly where it would otherwise leak.
 */
export function redactKey(text: string): string {
  return text
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[redacted private key]')
    .replace(/[A-Za-z0-9+/]{120,}={0,2}/g, '[redacted]')
}

function b64url(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Sign the JWT that Google exchanges for an access token (RS256, the only
 * algorithm the service-account grant accepts).
 *
 * `now` is injectable so a test can pin `iat`/`exp` and assert the claim set
 * exactly rather than around it.
 */
export function buildAssertion(key: ServiceAccountKey, scope: string, now: number = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope,
    aud: key.token_uri || TOKEN_URL(),
    iat: now,
    exp: now + 3600,
  }))
  const signingInput = `${header}.${claims}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.private_key)
  return `${signingInput}.${b64url(signature)}`
}

/** Exchange the service-account key for a short-lived access token. */
export async function getAccessToken(key: ServiceAccountKey, scope: string): Promise<string> {
  const assertion = buildAssertion(key, scope)
  const res = await fetch(key.token_uri || TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Google refused the service-account key (${res.status}): ${redactKey(body).slice(0, 300)}`)
  }
  const data = await res.json() as { access_token?: string }
  if (!data.access_token)
    throw new Error('Google returned no access token for that key.')
  return data.access_token
}

/** Read scopes, one per API. Read-only by construction — see the header. */
export const SCOPE_ANALYTICS_READONLY = 'https://www.googleapis.com/auth/analytics.readonly'
export const SCOPE_SEARCH_CONSOLE_READONLY = 'https://www.googleapis.com/auth/webmasters.readonly'
