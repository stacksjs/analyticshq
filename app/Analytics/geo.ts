/**
 * Country from an IP address, resolved on this machine.
 *
 * ## Why this exists
 *
 * Country was advertised as "resolved from your CDN edge headers" and, for the
 * entire life of the product, resolved to nothing at all. `getCountryFromHeaders`
 * reads four CDN headers (`cloudfront-viewer-country`, `x-country-code`,
 * `cf-ipcountry`, …); analyticshq.org runs on Hetzner behind rpx with no CDN, so
 * none were ever present and every row got `NULL`. The dashboard said "No country
 * data yet", which reads like an empty site rather than a broken feature.
 *
 * That was only half of it. rpx hardcoded `x-forwarded-for: 127.0.0.1`, so there
 * was no client IP to fall back to either — a geo lookup here would have resolved
 * every visitor on earth to loopback. Fixed in rpx 0.11.46; this module is the
 * half that lives in the app.
 *
 * ## Why a local database rather than a lookup service
 *
 * Sending a visitor's IP to a third party to ask where they are would undo the
 * thing this product sells. The database is a file on our own disk, the lookup is
 * a binary-tree walk in memory, and the IP is discarded immediately after — the
 * same breath in which it is hashed into the visitor id. Nothing leaves the box,
 * so this is *stricter* than the CDN-header story it replaces: that one required
 * a CDN to be terminating your traffic and seeing every visitor.
 *
 * ## Country by default, region only if asked for twice
 *
 * Country-only WAS an unconditional invariant here (issue #7, migration
 * `0000000011` which dropped the region and city columns). It is now the
 * default rather than the ceiling: a site owner can opt into region — state or
 * province, never city — and everything else stays where it was.
 *
 * Two independent things have to be true before a single region is recorded,
 * which is the point:
 *
 *  1. The site has `region_geo` on. Off for every site that exists, and off for
 *     every site created after this, because the column defaults to false.
 *  2. The operator installed a database that HAS subdivisions. The default file
 *     is still DB-IP's country-level one, which carries none, so a flag flipped
 *     without a deliberate change to the deployment records nothing.
 *
 * City is not reachable from either. `regionFromIp` reads `subdivisions[0]` and
 * nothing else, `tests/unit/privacy-guardrails.test.ts` still fails CI if a
 * `city` column reappears, and the comparison pages still say no city, ever.
 *
 * ## The database file
 *
 * DB-IP IP-to-Country Lite, MMDB format, CC BY 4.0 — chosen over MaxMind's
 * GeoLite2 because it downloads without an account, so a self-hoster gets
 * working country data instead of a signup form. ~8MB on disk, refreshed
 * monthly. Not committed: it is a binary blob with a monthly cadence and its own
 * license. `.github/workflows/deploy.yml` fetches it; `ANALYTICSHQ_GEO_DB`
 * overrides the path.
 *
 * DB-IP's City Lite file is the same format and license and is a drop-in for it:
 * point `ANALYTICSHQ_GEO_DB` at that instead and `regionFromIp` starts
 * answering. It is a much larger download, which is why it is not the default
 * and why fetching it is opt-in in the deploy workflow.
 *
 * Attribution is required by the license and is rendered on /features/geography.
 */

import type { Reader as MmdbReader } from 'mmdb-lib'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Reader } from 'mmdb-lib'
import { normCountry } from './country'

/**
 * Shape we read out of whichever database is installed. Everything else is
 * ignored.
 *
 * `subdivisions` is absent from the country database and present in the city
 * one, which is the entire mechanism behind opt-in region geo: the granularity
 * available to this install is a property of the FILE ON DISK, not of a flag.
 * An operator who never fetches the city database cannot turn regions on by
 * misconfiguring something, because there is nothing in the country database
 * for `regionFromIp` to return.
 */
interface GeoRecord {
  country?: { iso_code?: string }
  registered_country?: { iso_code?: string }
  /** ISO 3166-2 subdivisions, most general first. Only the first is read. */
  subdivisions?: Array<{ iso_code?: string, names?: { en?: string } }>
}

/**
 * Where the `.mmdb` lives. Resolved relative to this file rather than
 * `process.cwd()`, because the app is started from more than one directory
 * (`buddy serve`, the deployed systemd unit, `bun test`) and a cwd-relative
 * default silently resolves to nothing in whichever one you did not try.
 */
export function geoDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ANALYTICSHQ_GEO_DB?.trim()
  return override || join(import.meta.dir, '../../storage/geo/dbip-country-lite.mmdb')
}

/**
 * `null` until the first lookup, then either a Reader or `false` for "we tried
 * and there is no usable database". `false` rather than retrying, so a missing
 * file costs one failed read for the process lifetime instead of one per beacon.
 */
let cached: MmdbReader<GeoRecord> | false | null = null

/**
 * Load the database, once.
 *
 * Deliberately lazy rather than at module scope: importing this file must not
 * do 8MB of blocking I/O, and must not be able to throw. `/collect` inserts
 * into `page_views` without a `.catch()`, so an exception raised in here would
 * surface as a failed beacon — a missing geo database would stop the product
 * recording pageviews, which is a far worse outcome than an empty country
 * column.
 */
function reader(): MmdbReader<GeoRecord> | null {
  if (cached !== null)
    return cached || null
  try {
    cached = new Reader<GeoRecord>(readFileSync(geoDbPath()))
  }
  catch {
    // Absent, unreadable, or not a valid MMDB. All three mean the same thing to
    // a caller: no country. A self-hoster who never fetched the database gets
    // exactly the behaviour they had before this shipped.
    cached = false
  }
  return cached || null
}

/** Drop the memoised reader. Tests only — production loads once and keeps it. */
export function resetGeoCache(): void {
  cached = null
}

/**
 * Is this a syntactically complete address?
 *
 * Worth checking explicitly, because the reader is lenient in a way that
 * manufactures data: `mmdb-lib` accepts the classic `inet_aton` shorthand, so
 * the string `'1.2.3'` is read as an address and resolves to a real country
 * (AU). `x-forwarded-for` is attacker-adjacent input — anything reaching us
 * without passing through rpx can put arbitrary text in it — and a junk value
 * silently becoming Australia is worse than it becoming nothing, because a
 * wrong country is indistinguishable from a right one in the report.
 *
 * IPv4 must be four octets in range. IPv6 is left to the reader beyond a
 * charset check: the grammar has too many valid forms (`::`, embedded v4, zone
 * ids) to re-implement here, and an invalid one yields null rather than a
 * confident wrong answer.
 */
function isWellFormed(addr: string): boolean {
  if (addr.includes(':'))
    return /^[0-9a-f:.]+$/i.test(addr)
  const parts = addr.split('.')
  return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/**
 * ISO 3166-1 alpha-2 for an IP, or `null`.
 *
 * `null` covers every uninteresting case together: no database, a private or
 * loopback address (which is what a health check or a same-box request looks
 * like), an unroutable range the database has no opinion on, and malformed
 * input. None of them are errors worth distinguishing at the call site — they
 * all mean "no country recorded".
 */
function lookup(ip: string): GeoRecord | null {
  const addr = (ip || '').trim()
  // The pre-rpx-0.11.46 sentinel, and what a same-box request genuinely is.
  // Skipped before touching the database so a misconfigured proxy shows up as
  // no data rather than as a plausible-looking country.
  if (!addr || addr === '0.0.0.0' || addr === '127.0.0.1' || addr === '::1')
    return null
  if (!isWellFormed(addr))
    return null

  const db = reader()
  if (!db)
    return null

  try {
    return db.get(addr)
  }
  catch {
    return null
  }
}

export function countryFromIp(ip: string): string | null {
  const found = lookup(ip)
  // `registered_country` is the fallback the format provides for addresses
  // whose assignment is known but whose location is not.
  const iso = found?.country?.iso_code ?? found?.registered_country?.iso_code
  return iso ? normCountry(iso) : null
}

/**
 * ISO 3166-2 for an IP — `"US-CA"` — or `null`.
 *
 * ## Null is the normal answer
 *
 * This returns `null` for everything `countryFromIp` returns `null` for, and
 * then for two more cases that are the common ones in practice: the installed
 * database is the country-level file and carries no subdivisions at all, and
 * the address resolves to a country the city database has no subdivision for.
 * Region geo is opt-in per site AND requires the operator to have installed a
 * database that can answer, so "no region" is the default state of the product
 * and not a fault to report.
 *
 * ## Why the compound code, and not the bare subdivision
 *
 * The subdivision code alone is ambiguous across countries — `CA` is California
 * in `US-CA` and a dozen unrelated things elsewhere, and it collides with the
 * alpha-2 country code for Canada, so a bare column would mix regions and
 * countries in any query that touched both. Prefixing the country makes the
 * value globally unique and sorts regions of the same country together.
 *
 * ## Why only the first subdivision
 *
 * MMDB orders them most general first, so `subdivisions[0]` is the state or
 * province and anything after it is a county or district. Reading further down
 * would be a granularity nobody opted into: the setting is called region, the
 * comparison pages say region, and a county is neither.
 */
export function regionFromIp(ip: string): string | null {
  const found = lookup(ip)
  const iso = found?.country?.iso_code ?? found?.registered_country?.iso_code
  const country = iso ? normCountry(iso) : null
  if (!country)
    return null

  const sub = found?.subdivisions?.[0]?.iso_code?.trim()
  if (!sub)
    return null
  // Upper case and A-Z0-9 only: ISO 3166-2 subdivision codes are one to three
  // of those, and anything else is a database we did not expect rather than a
  // region worth writing into a column.
  const code = sub.toUpperCase()
  if (!/^[A-Z0-9]{1,3}$/.test(code))
    return null

  return `${country}-${code}`
}

/**
 * Can the installed database answer region queries at all?
 *
 * For `/api/health`, which reports country resolution the same way. A site that
 * opted into regions and is recording none is almost always this: the operator
 * turned the setting on and left the country-level database in place.
 */
export function geoHasRegions(): boolean {
  return regionFromIp('8.8.8.8') !== null
}
