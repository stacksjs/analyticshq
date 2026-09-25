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
 * ## Country by default, region and city only if asked for twice
 *
 * Country-only WAS an unconditional invariant here (issue #7, migration
 * `0000000011` which dropped the region and city columns). It is now the
 * default rather than the ceiling: a site owner can opt into region (state or
 * province) and, separately, into city. Neither is on for any site until its
 * owner turns it on.
 *
 * Two independent things have to be true before a single region or city is
 * recorded, which is the point:
 *
 *  1. The site has `region_geo` (or `city_geo`) on, and the install's
 *     `geo.granularity` ceiling reaches that level. Both columns default to
 *     false, for every site that exists and every site created after.
 *  2. The operator installed a database that HAS subdivisions and cities. DB-IP's
 *     country-level file carries neither, so a flag flipped on an install
 *     running it records nothing.
 *
 * City is the name of the place only: never coordinates, never a postcode, and
 * never anything below the city. `cityFromIp` reads `city.names.en` and nothing
 * else from the record, and a city row is subject to the same per-row disclosure
 * floor as a region (`app/Analytics/cities.ts`), because a town with two
 * visitors is a smaller haystack than any state.
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
 * with that file on disk `regionFromIp` and `cityFromIp` start answering, and
 * `countryFromIp` keeps working unchanged. The deploy workflow fetches City Lite
 * by default (`ANALYTICSHQ_GEO_CITY=false` falls back to the country file), so
 * a site owner who turns regions or cities on gets data without an operator
 * having to find a setting first.
 *
 * Attribution is required by the license and is rendered on /features/geography.
 */

import type { Reader as MmdbReader } from 'mmdb-lib'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Reader } from 'mmdb-lib'
import { normCountry } from './country'
import SUBDIVISIONS from './subdivisions.json'

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
  /**
   * Subdivisions, most general first. Only the first is read.
   *
   * `iso_code` is there in MaxMind's files and ABSENT from DB-IP's: a DB-IP City
   * Lite record says `[{ names: { en: 'California' } }]` and nothing else. See
   * `regionOf` for what that cost and how the name is turned into a code.
   */
  subdivisions?: Array<{ iso_code?: string, names?: { en?: string } }>
  /** The city. Only its English name is read; `location` is never touched. */
  city?: { names?: { en?: string } }
}

/**
 * Location granularities, coarsest first. `config/privacy.ts` sets the finest
 * one an install permits; a site then opts into region or city on its own.
 */
export const GEO_LEVELS = ['none', 'country', 'region', 'city'] as const
export type GeoLevel = typeof GEO_LEVELS[number]

/**
 * Does an install whose ceiling is `ceiling` permit recording at `level`?
 *
 * By rank rather than by equality, which is what the old `=== 'region'` checks
 * became wrong about the moment a finer level existed: an install that permits
 * city permits region too. An unknown ceiling permits nothing finer than
 * `'none'` — a typo in config must fail closed.
 */
export function geoPermits(ceiling: string, level: GeoLevel): boolean {
  const have = (GEO_LEVELS as readonly string[]).indexOf(ceiling)
  return have >= 0 && have >= GEO_LEVELS.indexOf(level)
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
 * Swap in a reader. Tests only: the real database is a monthly download that CI
 * does not have, and the city path needs a record with a city in it to be
 * exercised at all. Anything with a `get(ip)` returning DB-IP's record shape
 * will do. `resetGeoCache()` puts the file-backed reader back.
 */
export function setGeoReaderForTests(r: { get: (ip: string) => GeoRecord | null } | null): void {
  cached = r ? (r as unknown as MmdbReader<GeoRecord>) : false
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
/**
 * The bare address out of the spellings proxies actually send.
 *
 * `x-forwarded-for` and `x-real-ip` are not always a bare address. Seen in the
 * wild: an IPv4-mapped IPv6 address (`::ffff:203.0.113.7`, which is what a
 * dual-stack socket reports for a v4 peer), a v4 address with the port still on
 * it (`203.0.113.7:51234`), and a bracketed v6 address with a port
 * (`[2001:db8::1]:443`). Each of those used to fail `isWellFormed` or miss the
 * database, and every one of them is a real visitor recorded with no location.
 *
 * Anything that does not match one of those shapes is returned as it came, for
 * `isWellFormed` to accept or refuse.
 */
export function normalizeIp(ip: string): string {
  let addr = (ip || '').trim()
  // [v6]:port or [v6]
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d+)?$/i.exec(addr)
  if (bracketed)
    addr = bracketed[1]
  // v4:port — exactly one colon, so a v6 address is never mistaken for it.
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(addr)
  if (v4port)
    addr = v4port[1]
  // ::ffff:a.b.c.d — the v4 address a dual-stack listener wraps it in.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr)
  if (mapped)
    addr = mapped[1]
  return addr
}

function lookup(ip: string): GeoRecord | null {
  const addr = normalizeIp(ip)
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
  return countryOf(lookup(ip))
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
  return regionOf(lookup(ip))
}

/**
 * The country out of a record, normalized, or null. `registered_country` is the
 * fallback the format provides for addresses whose assignment is known but whose
 * location is not.
 */
function countryOf(found: GeoRecord | null): string | null {
  const iso = found?.country?.iso_code ?? found?.registered_country?.iso_code
  return iso ? normCountry(iso) : null
}

/**
 * DB-IP subdivision name -> ISO 3166-2 subdivision code, per country.
 * Generated by `scripts/geo/build-subdivisions.ts` from the City Lite file.
 */
const SUBDIVISION_CODES = SUBDIVISIONS as Record<string, Record<string, string>>

/**
 * `US-CA` out of a record, or null. The body of `regionFromIp`.
 *
 * ## The code, or the name looked up
 *
 * This used to read `subdivisions[0].iso_code` and nothing else. DB-IP's City
 * Lite, the only database the deploy fetches and the one the docs point at,
 * does not carry that field: its subdivisions have an English name and no code.
 * So region geo returned null for every address with every database this
 * product ships, and a site that opted in recorded no states at all.
 *
 * Now the code is used when the file has one (MaxMind's GeoLite2 does), and
 * otherwise the English name is looked up in a table generated from the City
 * Lite file itself. A name the table does not know is null, never a guess.
 */
function regionOf(found: GeoRecord | null): string | null {
  const country = countryOf(found)
  if (!country)
    return null

  const first = found?.subdivisions?.[0]
  const name = first?.names?.en?.trim()
  const sub = first?.iso_code?.trim() || (name ? SUBDIVISION_CODES[country]?.[name] : undefined)
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

/** Longest city name kept. The column is varchar(100); the prefix takes seven. */
export const CITY_NAME_MAX = 80

/**
 * The city an IP resolves to, as `US-CA:San Diego` — or `null`.
 *
 * ## Why the compound value
 *
 * A bare city name is ambiguous in exactly the way a bare subdivision code is:
 * there are Springfields in a dozen states and a Paris in Texas. Prefixing the
 * region (or, where the database has no subdivision for that country, the
 * country alone: `SG:Singapore`) makes the value globally unique, so grouping
 * by the column cannot merge two places, and a filter on one row cannot match
 * another town of the same name. It also keeps the flag and the state on the
 * row without a second column.
 *
 * ## Null is still the normal answer
 *
 * Every case `countryFromIp` returns null for, the country-level database (no
 * `city` in any record), and addresses DB-IP places in a country but no city.
 *
 * ## What is read, and what is not
 *
 * `city.names.en`, trimmed, with control characters and the `:` separator
 * removed, capped at {@link CITY_NAME_MAX}.
 *
 * A trailing parenthetical is dropped, and that is a privacy rule as much as a
 * tidy one. DB-IP writes a NEIGHBOURHOOD there on about a fifth of its city
 * names: "San Diego (La Jolla)", "Seattle (South Lake Union)", "Singapore
 * (Orchard)". Kept, the setting called city would record districts, and one
 * city would split into a hundred rows (San Diego alone appears under more than
 * a hundred) that each fall under the disclosure floor. Dropped, every one of
 * them is "San Diego". The record's `location` (latitude,
 * longitude, accuracy radius) and `postal` are never read: the finest thing this
 * product records is the name of a city.
 */
export function cityFromIp(ip: string): string | null {
  const found = lookup(ip)
  const place = regionOf(found) ?? countryOf(found)
  if (!place)
    return null

  const raw = found?.city?.names?.en
  if (typeof raw !== 'string')
    return null
  const name = raw
    // The neighbourhood: "San Diego (La Jolla)" -> "San Diego".
    .replace(/\s*\([^()]*\)\s*$/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CITY_NAME_MAX)
    .trim()
  if (!name)
    return null

  return `${place}:${name}`
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

/**
 * Can the installed database answer city queries at all? `/api/health` reports
 * it next to `geoRegion`, for the same reason: "I turned cities on and see none"
 * is almost always the country database still being on disk.
 */
export function geoHasCities(): boolean {
  return cityFromIp('8.8.8.8') !== null
}
