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
import { normCountry } from './country'
import { countryFromIp, normalizeIp } from './geo'

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
  return createHash('sha256').update(`${visitorIpKey(ip)}|${ua}|${siteId}|${salt}`).digest('hex').slice(0, 32)
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(addr: string): string[] | null {
  let text = addr
  // A dotted IPv4 tail (`64:ff9b::192.0.2.1`) is the last two groups.
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (tail) {
    const o = tail[2].split('.').map(Number)
    if (o.some(n => n > 255))
      return null
    text = `${tail[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2)
    return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? missing !== 0 : missing < 1)
    return null
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...rest]
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g)))
    return null
  return groups.map(g => g.toLowerCase().replace(/^0+(?=.)/, ''))
}

/**
 * The part of the address the visitor hash uses.
 *
 * IPv4 as it is. IPv6 cut to its /64 network, `2001:db8:1:2::/64`, because the
 * lower 64 bits of most client addresses are a privacy address the device
 * regenerates every day or so (RFC 8981). Hashing the whole address split one
 * phone into a new "visitor" each time that happened, which a 30-day visitor
 * timeline cannot survive. The /64 is what stays put: it is the household or
 * the carrier's allocation for that device, the same granularity a v4 address
 * already has behind a home router. So the id also says less, not more.
 *
 * Proxy spellings are unwrapped first (`normalizeIp`), so `::ffff:a.b.c.d` is
 * the v4 address it wraps. Anything unparseable is hashed as it came rather
 * than guessed at.
 */
export function visitorIpKey(ip: string): string {
  const addr = normalizeIp(ip).toLowerCase()
  if (!addr.includes(':'))
    return addr
  const groups = ipv6Groups(addr)
  if (!groups)
    return addr
  // NAT64 (64:ff9b::/96) carries the visitor's own IPv4 in its last 32 bits,
  // and every visitor behind that gateway shares the /64. Hash the v4 inside.
  if (groups.slice(0, 6).join(':') === '64:ff9b:0:0:0:0') {
    const hi = Number.parseInt(groups[6], 16)
    const lo = Number.parseInt(groups[7], 16)
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
  }
  return `${groups.slice(0, 4).join(':')}::/64`
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

/**
 * Country as an ISO 3166-1 alpha-2 code, or `null`.
 *
 * Two sources, CDN header first:
 *
 *  1. `cf-ipcountry` and friends, when something upstream already resolved it.
 *     Free and authoritative when present, and keeps working for a self-hoster
 *     behind Cloudflare or CloudFront who never fetches a database.
 *  2. A local IP lookup (`./geo`). This is the path that actually runs for us —
 *     analyticshq.org has no CDN in front of it, which is why country was
 *     empty for the entire life of the product.
 *
 * ## Both sources are normalized, and that is not cosmetic
 *
 * `getCountryFromHeaders` returns the full English NAME for the ~50 codes it
 * knows ("United States") and the bare code only for the ones it does not.
 * `page_views.country` is `varchar(2)`. So the header path — the one path that
 * was believed to work — would have errored or truncated on every recognized
 * country, turning the Netherlands into a country called "Ne". It never
 * surfaced because the header was never present to begin with.
 */
export function geoCountry(headers: Headers, ip?: string): string | null {
  const obj: Record<string, string> = {}
  headers.forEach((v, k) => { obj[k.toLowerCase()] = v })

  const fromHeader = getCountryFromHeaders(obj)
  if (fromHeader) {
    const code = normCountry(fromHeader)
    if (code)
      return code
  }

  return ip ? countryFromIp(ip) : null
}

/** A short, URL-safe random id (for pageview / event primary keys). */
export function randomId(): string {
  return createHash('sha256').update(globalThis.crypto.randomUUID()).digest('hex').slice(0, 24)
}
