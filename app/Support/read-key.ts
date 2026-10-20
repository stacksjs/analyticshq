/**
 * A site's read key: the credential a machine presents to read that site's
 * analytics.
 *
 * There was no per-site credential to extend. The tracker is a public script
 * beaconing to a site id, so unlike loghq and bughq this is a new credential
 * rather than a second mode on an existing one — and unlike those, it has no
 * public sibling to be confused with. It returns data, so it is a secret: 256
 * bits, compared in constant time, and accepted only on the reads listed on
 * the issue rather than on all forty-odd site routes.
 *
 * It authorises exactly one site. There is no account behind it, so it
 * outlives the person who created it and carries none of their scope — which
 * is the whole reason it exists (stacksjs/analyticshq#67): a Stacks dashboard
 * reading a site server-to-server should not be holding somebody's session.
 */

/**
 * `ahq_read_` then 256 bits of hex.
 *
 * The prefix is doing real work. It tells a read key apart from a user's
 * bearer token before either is verified, so a read key is never handed to
 * `Auth.getUserFromToken`; and it gives secret scanners something to match, so
 * a key pasted into a repository can be found and revoked.
 */
const PREFIX = 'ahq_read_'
const BODY = /^[0-9a-f]{64}$/

export function newReadKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  return PREFIX + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Whether a presented credential is shaped like a read key at all. */
export function looksLikeReadKey(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX) && BODY.test(value.slice(PREFIX.length))
}

/**
 * Equal, in time that does not depend on how much of the key is right.
 *
 * `===` on a string short-circuits at the first differing byte, which leaks
 * the length of a correct prefix to anyone who can measure the response. That
 * is a real attack on a secret an attacker can guess at repeatedly, and not
 * one on the public ingest key, which is why only this side does it.
 */
export function sameKey(presented: string, stored: string): boolean {
  if (presented.length !== stored.length)
    return false
  let diff = 0
  for (let i = 0; i < presented.length; i++)
    diff |= presented.charCodeAt(i) ^ stored.charCodeAt(i)
  return diff === 0
}

export interface ReadKeySite {
  id: string
  read_key?: string | null
}

export type ReadAuthorization =
  | { ok: true }
  | { ok: false, status: 401 | 403 | 404, error: string }

/**
 * Whether this key may read this site.
 *
 * Site ids are public — they are embedded in the tracking snippet — so unlike
 * loghq and bughq, telling 404 from 403 here leaks nothing, and the existing
 * requireSiteRole already distinguishes them. The wording matches it so a
 * refusal reads the same whichever credential was presented.
 */
export function authorizeRead(site: ReadKeySite | null | undefined, presented: unknown): ReadAuthorization {
  if (!site)
    return { ok: false, status: 404, error: 'Site not found' }
  // No key issued is not the same as "any key will do": a site without one
  // must refuse every presented key, including an empty one.
  if (!looksLikeReadKey(site.read_key))
    return { ok: false, status: 403, error: 'Forbidden' }
  if (!looksLikeReadKey(presented) || !sameKey(presented, site.read_key))
    return { ok: false, status: 401, error: 'Unauthorized' }
  return { ok: true }
}

/**
 * How often a key's last-used stamp is written.
 *
 * The stamp is there so somebody can see whether a key is still in use before
 * revoking it, which a minute's resolution answers. Writing on every request
 * would put an UPDATE in front of every read of a log stream that a dashboard
 * polls.
 */
export const LAST_USED_RESOLUTION_MS = 60_000

export function shouldRecordUse(lastUsedAt: string | Date | null | undefined, now: Date): boolean {
  if (!lastUsedAt)
    return true
  const previous = lastUsedAt instanceof Date ? lastUsedAt.getTime() : Date.parse(String(lastUsedAt))
  if (Number.isNaN(previous))
    return true
  return now.getTime() - previous >= LAST_USED_RESOLUTION_MS
}
