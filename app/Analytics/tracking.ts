/**
 * Analytics tracking glue.
 *
 * The backend-agnostic primitives — User-Agent parsing, bot filtering,
 * referrer classification, CDN geo-header extraction — come from the shared
 * dependency-free `@ts-analytics/tracking` package.
 * Only the pieces specific to *this* app live here: cookieless daily-salt
 * visitor hashing, header IP extraction, and id generation.
 */

import { createHash } from 'node:crypto'
import { getCountryFromHeaders } from '@ts-analytics/tracking'

// Re-export the shared primitives so route code has a single import site.
export {
  isBot,
  type ParsedUserAgent,
  parseUserAgent,
  parseReferrerSource as referrerSource,
} from '@ts-analytics/tracking'

/**
 * Cookieless visitor id: sha256(ip + ua + siteId + daily-salt), truncated.
 * No raw IP or UA is persisted — only this opaque digest.
 *
 * The salt is passed in rather than derived here, and that is the whole point of
 * #9. It used to be the UTC date: public, so the only unknown in the digest was
 * the IP, which made a stored visitor id a confirmation oracle — take a
 * candidate IP and User-Agent, hash it, and see whether that person visited.
 * The salt is now a per-site-per-day secret (see ./salt.ts), and once it is
 * purged the day's hashes are unlinkable to any input.
 *
 * Keeping this a pure function of its inputs also means the hash can be tested
 * without a database, which the previous signature quietly prevented.
 */
export function hashVisitor(ip: string, ua: string, siteId: string, salt: string): string {
  return createHash('sha256').update(`${ip}|${ua}|${siteId}|${salt}`).digest('hex').slice(0, 32)
}

/**
 * Store a referrer without its query string or fragment.
 *
 * A referral URL's `?query` can carry identifiers minted by the *referring* site
 * (click ids, session tokens, emails), so we keep only `origin + pathname` —
 * enough for the referrers report — and drop everything after. Deterministic, so
 * the same referrer always aggregates to one row. Non-URL values still get `?`/`#`
 * and anything after them stripped. Result is clipped to a varchar(255). See #6.
 */
export function cleanReferrer(v: unknown): string | null {
  if (typeof v !== 'string')
    return null
  const t = v.trim()
  if (!t)
    return null
  let stripped: string
  try {
    const u = new URL(t)
    stripped = u.origin + u.pathname
  }
  catch {
    stripped = t.split(/[?#]/)[0]
  }
  return stripped.length > 255 ? stripped.slice(0, 255) : stripped
}

/** Best-effort client IP from common proxy/CDN headers. */
export function clientIp(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip')
    || headers.get('x-real-ip')
    || headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || '0.0.0.0'
  )
}

/** Country from CDN geo headers (via ts-analytics), no third-party lookup. */
export function geoCountry(headers: Headers): string | undefined {
  const obj: Record<string, string> = {}
  headers.forEach((v, k) => { obj[k.toLowerCase()] = v })
  return getCountryFromHeaders(obj)
}

/** A short, URL-safe random id (for pageview / event primary keys). */
export function randomId(): string {
  return createHash('sha256').update(globalThis.crypto.randomUUID()).digest('hex').slice(0, 24)
}
