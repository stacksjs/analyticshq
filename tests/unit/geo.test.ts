/**
 * Country resolution.
 *
 * There was no test for this, anywhere, which is the reason it could ship
 * broken and stay broken: `geoCountry()` returned `undefined` for every visitor
 * for the entire life of the product, the column filled with `NULL`, and the
 * dashboard rendered "No country data yet" — which reads like a site with no
 * traffic rather than a feature that never worked.
 *
 * Two independent bugs were involved, and both are pinned here:
 *
 *  1. Resolution only ever consulted four CDN headers. Production has no CDN.
 *  2. `getCountryFromHeaders` returns the full English NAME for the ~50
 *     countries it knows, and `page_views.country` is `varchar(2)`. So even the
 *     path believed to work would have errored or truncated on every recognized
 *     country. That one was invisible behind the first.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normCountry } from '../../app/Analytics/country'
import { countryFromIp, geoDbPath, resetGeoCache } from '../../app/Analytics/geo'
import { geoCountry } from '../../app/Analytics/tracking'

/** Build a Headers from a plain object, the shape `/collect` receives. */
function headers(h: Record<string, string> = {}): Headers {
  const out = new Headers()
  for (const [k, v] of Object.entries(h))
    out.set(k, v)
  return out
}

afterEach(() => {
  delete process.env.ANALYTICSHQ_GEO_DB
  resetGeoCache()
})

describe('normCountry keeps the column honest', () => {
  test('a full name becomes its ISO code', () => {
    // The bug: "United States" into a varchar(2). Postgres either raises 22001
    // or truncates, and "Un" is not a country.
    expect(normCountry('United States')).toBe('US')
    expect(normCountry('Netherlands')).toBe('NL')
  })

  test('an ISO code passes through, upper-cased', () => {
    expect(normCountry('de')).toBe('DE')
    expect(normCountry('GB')).toBe('GB')
  })

  test('an unmapped name is null, never a truncated guess', () => {
    // "no country recorded" is a correct answer. "Ne" is a fabricated one.
    expect(normCountry('Wakanda')).toBeNull()
    expect(normCountry('')).toBeNull()
  })

  test('never returns anything the column cannot hold', () => {
    const inputs = ['United States', 'de', 'Wakanda', '', '   ', 'X', 'ABC', 'Czechia']
    for (const v of inputs) {
      const out = normCountry(v)
      expect({ v, ok: out === null || /^[A-Z]{2}$/.test(out) }).toEqual({ v, ok: true })
    }
  })
})

describe('geoCountry prefers a CDN header, and normalizes it', () => {
  test('a CDN header still wins, so a Cloudflare self-hoster needs no database', () => {
    expect(geoCountry(headers({ 'cf-ipcountry': 'DE' }))).toBe('DE')
    expect(geoCountry(headers({ 'cloudfront-viewer-country': 'JP' }))).toBe('JP')
  })

  test('a header that resolves to a full name is coerced to a code', () => {
    // getCountryFromHeaders maps 'US' -> 'United States' before we ever see it.
    // Without normalization that is what reached the varchar(2) insert.
    const out = geoCountry(headers({ 'cf-ipcountry': 'US' }))
    expect(out).toBe('US')
    expect(out!.length).toBe(2)
  })

  test('no header and no IP is null, not a crash', () => {
    expect(geoCountry(headers())).toBeNull()
  })

  test("XX means 'unknown' and must not become a country", () => {
    expect(geoCountry(headers({ 'cf-ipcountry': 'XX' }))).toBeNull()
  })
})

describe('countryFromIp: the addresses that must never resolve', () => {
  test('loopback, unspecified and private ranges are null', () => {
    // 127.0.0.1 specifically: it is what rpx sent as x-forwarded-for for every
    // visitor before 0.11.46, and 0.0.0.0 is clientIp()'s own fallback. If
    // either ever resolved to a country, a misconfigured proxy would show up as
    // a plausible-looking report instead of as missing data.
    for (const ip of ['127.0.0.1', '0.0.0.0', '::1', '']) {
      expect({ ip, country: countryFromIp(ip) }).toEqual({ ip, country: null })
    }
  })

  test('malformed input is null rather than an exception', () => {
    // /collect inserts into page_views with no .catch() — a throw here would
    // drop the pageview, so a bad IP must degrade to "no country", not to a
    // failed beacon.
    for (const ip of ['garbage', '999.999.999.999', 'null', '<script>', '1.2.3.4.5', '  ']) {
      expect({ ip, country: countryFromIp(ip) }).toEqual({ ip, country: null })
    }
  })

  test('a partial address is not silently completed into a real country', () => {
    // mmdb-lib accepts inet_aton shorthand, so '1.2.3' resolved to AU before
    // this was guarded. x-forwarded-for is attacker-adjacent input, and a junk
    // value becoming a confident wrong country is worse than becoming nothing —
    // in the report the two are indistinguishable.
    for (const ip of ['1.2.3', '1.2', '8', '8.8']) {
      expect({ ip, country: countryFromIp(ip) }).toEqual({ ip, country: null })
    }
  })

  test('an octet out of range does not resolve', () => {
    expect(countryFromIp('8.8.8.256')).toBeNull()
    expect(countryFromIp('300.1.1.1')).toBeNull()
  })

  test('a missing database yields null and does not throw', () => {
    process.env.ANALYTICSHQ_GEO_DB = '/nonexistent/definitely-not-here.mmdb'
    resetGeoCache()
    expect(countryFromIp('8.8.8.8')).toBeNull()
  })

  test('an unreadable/corrupt database yields null and does not throw', () => {
    // A truncated download is a realistic deploy failure and must not take
    // ingest down with it.
    process.env.ANALYTICSHQ_GEO_DB = join(import.meta.dir, '../../package.json')
    resetGeoCache()
    expect(countryFromIp('8.8.8.8')).toBeNull()
  })
})

describe('countryFromIp against the real database', () => {
  // Skipped when the .mmdb has not been fetched — a fresh clone must not fail
  // CI for a binary blob it was never given. The deploy workflow fetches it, and
  // these run wherever it is present.
  const dbPath = geoDbPath()
  const present = existsSync(dbPath)
  const maybe = present ? test : test.skip

  maybe('resolves well-known IPv4 addresses', () => {
    expect(countryFromIp('8.8.8.8')).toBe('US')
    expect(countryFromIp('1.1.1.1')).toBe('AU')
  })

  maybe('resolves IPv6 too', () => {
    // Visitors are increasingly v6-only; resolving v4 alone would quietly lose
    // a growing share of traffic to "unknown".
    expect(countryFromIp('2001:4860:4860::8888')).toBe('CA')
  })

  maybe('always returns something the column can hold', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '212.227.222.8', '2001:4860:4860::8888']) {
      const out = countryFromIp(ip)
      expect({ ip, ok: out !== null && /^[A-Z]{2}$/.test(out) }).toEqual({ ip, ok: true })
    }
  })

  maybe('an IP wins when no CDN header is present — the production case', () => {
    // This is the whole fix: analyticshq.org has no CDN, so this is the only
    // path that ever runs for us.
    expect(geoCountry(headers(), '8.8.8.8')).toBe('US')
  })

  maybe('is fast enough to sit in the ingest path', () => {
    // ~46µs/lookup measured. The assertion is deliberately loose — it is here to
    // catch a change that makes this do I/O per beacon, not to benchmark.
    const t = performance.now()
    for (let i = 0; i < 2000; i++) countryFromIp('8.8.8.8')
    expect(performance.now() - t).toBeLessThan(2000)
  })

  maybe('is the country database, not the city one', () => {
    // Country-only is an invariant (#7, #28). Loading a city-level DB here would
    // be a product decision smuggled in as a file swap, so assert the file we
    // actually load has no city data in it.
    const raw = readFileSync(dbPath)
    const meta = raw.subarray(raw.length - 200_000).toString('latin1')
    expect(meta).toContain('Country')
    expect(meta).not.toContain('DBIP-City')
  })
})

/**
 * What we tell visitors has to match what the code does.
 *
 * The CDN-header claim outlived the mechanism by the entire life of the
 * product: four public pages asserted that country "resolves from your CDN edge
 * headers", on a product whose own production box has no CDN, so the sentence
 * was decorating a feature that returned nothing. `config/privacy.ts` already
 * says in prose that changing geo means changing `competitors.ts` in the same
 * commit — this is that rule, enforced.
 */
describe('the public copy matches how country actually resolves', () => {
  const surfaces = [
    'resources/views/index.stx',
    'resources/views/features.stx',
    'resources/views/features/geography.stx',
    'resources/data/competitors.ts',
  ].map(rel => ({ rel, src: readFileSync(join(import.meta.dir, '../..', rel), 'utf8') }))

  test('no page claims country comes from a CDN edge header', () => {
    // Not a style rule. On any host without a CDN — every self-hosted install,
    // and analyticshq.org itself — that sentence describes a feature that
    // silently records nothing.
    for (const { rel, src } of surfaces) {
      const claims = /CDN edge header|from your CDN|resolved at the edge|Edge-resolved/i.exec(src)
      expect({ rel, claim: claims?.[0] ?? null }).toEqual({ rel, claim: null })
    }
  })

  test('the DB-IP attribution is rendered somewhere a visitor can reach', () => {
    // CC BY 4.0 on the country database. This is a license obligation, so it
    // cannot quietly disappear in a copy edit.
    const geography = surfaces.find(s => s.rel.endsWith('geography.stx'))!.src
    expect(geography).toContain('db-ip.com')
    expect(geography).toContain('CC BY 4.0')
  })

  test('the country-only promise is still made', () => {
    // The invariant behind #7 and #28. If this ever stops being claimed it
    // should be because the product changed, which is a decision, not an edit.
    const competitors = surfaces.find(s => s.rel.endsWith('competitors.ts'))!.src
    expect(competitors).toMatch(/Country only/)
  })
})

describe('the ingest path is wired to all of this', () => {
  const routes = readFileSync(join(import.meta.dir, '../../routes/analytics.ts'), 'utf8')

  test('geoCountry receives the client IP, not just headers', () => {
    // Without the second argument this is the old, permanently-empty behaviour.
    expect(routes).toMatch(/geoCountry\(request\.headers,\s*ip\)/)
  })

  test('resolution is still gated on the privacy granularity', () => {
    expect(routes).toContain("privacy.geo.granularity === 'country'")
  })

  test('the IP is not persisted anywhere', () => {
    // It is read for the visitor hash and geo, then dropped. If it ever reaches
    // an insert, the whole privacy claim goes with it.
    expect(routes).not.toMatch(/\bip:\s*ip\b|ip_address:/)
  })
})
