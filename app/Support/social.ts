/**
 * Social sign-in: the provider drivers and the signed OAuth `state`.
 *
 * Shared by SocialRedirectAction and SocialCallbackAction, which each kept
 * their own copy of both and read the config through `as any`. The config is
 * this app's own `config/services.ts` and `config/app.ts`, imported directly so
 * the provider keys are typed as written there.
 *
 * `state` is `<ms>.<hmac>`, keyed by APP_KEY and good for ten minutes, so the
 * callback can reject a forged or replayed request without server-side session
 * storage. With no APP_KEY there is nothing to sign with: it used to fall back
 * to a constant anyone could read in the source, and now social sign-in is
 * simply unavailable instead.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import { GitHubProvider, GoogleProvider } from '@stacksjs/socials'
import app from '../../config/app'
import services from '../../config/services'

export type SocialProvider = 'github' | 'google'

const STATE_TTL_MS = 600_000

export function isSocialProvider(v: string): v is SocialProvider {
  return v === 'github' || v === 'google'
}

/** Whether the provider has credentials, and state can be signed. */
export function socialConfigured(provider: SocialProvider): boolean {
  return Boolean(services[provider].clientId && stateKey())
}

export function socialDriver(provider: SocialProvider): GitHubProvider | GoogleProvider {
  const { clientId, clientSecret, redirectUrl } = services[provider]
  const creds = { clientId, clientSecret, redirectUrl }
  return provider === 'github' ? new GitHubProvider(creds) : new GoogleProvider(creds)
}

function stateKey(): string {
  return String(app.key || process.env.APP_KEY || '')
}

function sign(ts: string, key: string): string {
  return createHmac('sha256', key).update(ts).digest('hex').slice(0, 32)
}

/** A fresh state value, or null when there is no key to sign it with. */
export function signState(now: number = Date.now()): string | null {
  const key = stateKey()
  if (!key)
    return null
  const ts = String(now)
  return `${ts}.${sign(ts, key)}`
}

export function verifyState(state: string, now: number = Date.now()): boolean {
  const key = stateKey()
  const [ts, sig] = state.split('.')
  if (!key || !ts || !sig)
    return false
  const expected = Buffer.from(sign(ts, key))
  const given = Buffer.from(sig)
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return false
  const age = now - Number(ts)
  return age >= 0 && age < STATE_TTL_MS
}
