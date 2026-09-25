/**
 * Privacy guardrails — executable invariants.
 *
 * analyticshq is an aggregate-only, cookieless analytics product. These tests
 * fail CI the moment the code drifts toward individual-level tracking, so the
 * privacy contract in PRIVACY.md can't silently regress. See issue #28.
 *
 * They assert against the real tracker/ingest source and package manifest — not
 * a mock — so any PR that adds cookies, stores a raw IP, records region or city
 * for a site that did not ask, or pulls in a session-replay/heatmap library
 * trips a red test.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashVisitor } from '../../app/Analytics/tracking'

const root = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// The tracker (`GET /script.js`) and the `/collect` ingest both live here.
const analytics = read('routes/analytics.ts')
const pkg = read('package.json')

describe('guardrail: cookieless / no device storage', () => {
  test('the tracker never touches cookies, localStorage, sessionStorage or indexedDB', () => {
    for (const token of ['document.cookie', 'localStorage', 'sessionStorage', 'indexedDB'])
      expect(analytics).not.toContain(token)
  })
})

describe('guardrail: region and city only when asked for twice', () => {
  test('the ingest populates city only from the gated lookup', () => {
    // City used to be unreachable (#7). It is now an opt-in on the same terms
    // as region, and this pins the terms: the only value ever written is the
    // one cityFromIp returns, and only when siteWantsCity said yes.
    expect(analytics).toMatch(/city\s*=\s*\(await siteWantsCity\([\s\S]{0,40}\?\s*cityFromIp/)
    // And nothing else assigns the column a value.
    for (const m of analytics.matchAll(/^\s*city\s*:\s*(.+)$/gm))
      expect(m[1].trim()).toBe('city ?? null,')
  })

  test('the city column arrives only by its own migration, and defaults off', () => {
    // The original tables still carry no city; 0000000054 adds it alongside a
    // per-site flag that is false for every site until its owner flips it.
    for (const f of [
      'database/migrations/0000000003-create-page_views-table.sql',
      'database/migrations/0000000005-create-sessions-table.sql',
      'database/migrations/0000000051-add-opt-in-region-geo.sql',
    ])
      expect(read(f)).not.toMatch(/["\s]city["\s]*(varchar|:)/i)
    const sql = read('database/migrations/0000000054-add-opt-in-city-geo.sql')
    expect(sql).toContain('"city_geo" boolean NOT NULL DEFAULT false')
    expect(sql).not.toMatch(/UPDATE\s+"?sites"?\s+SET/i)
  })

  test('region is written only when the install permits it and the site asked', () => {
    // Two independent gates, and this pins that neither was collapsed into the
    // other: an instance check that returns before any query, and a per-site flag.
    expect(analytics).toMatch(/!geoPermits\(privacy\.geo\.granularity, 'region'\)\)\s*\n\s*return false/)
    expect(analytics).toContain('siteWantsRegion')
    // The region value never comes from anywhere but the subdivision lookup.
    expect(analytics).toMatch(/region\s*=\s*\(await siteWantsRegion\([\s\S]{0,40}\?\s*regionFromIp/)
  })

  test('city is written only when the install permits it and the site asked', () => {
    expect(analytics).toMatch(/!geoPermits\(privacy\.geo\.granularity, 'city'\)\)\s*\n\s*return false/)
    const fn = analytics.slice(analytics.indexOf('async function siteWantsCity'), analytics.indexOf('async function siteWantsCity') + 300)
    expect(fn).toContain('.city')
  })

  test('the site flags are read fail-closed', () => {
    // A query that threw must read as "off" for both, never as "on".
    const fn = analytics.slice(analytics.indexOf('async function siteGeoOptIns'), analytics.indexOf('async function siteWantsRegion'))
    expect(fn).toContain('.catch(() => null)')
    expect(fn).toContain('return { region: false, city: false, windowDays: 1 }')
  })

  test('a site cannot opt in on an install that does not permit it', () => {
    // Refused with a 409 rather than stored: a setting that saves, reads back as
    // on and records nothing sends the owner debugging their snippet.
    for (const [field, level] of [['regionGeo', 'region'], ['cityGeo', 'city']]) {
      const patch = analytics.slice(analytics.indexOf(`body.${field} !== undefined`))
      expect({ field, ok: new RegExp(`geoPermits\\(privacy\\.geo\\.granularity, '${level}'\\)[\\s\\S]{0,400}409`).test(patch.slice(0, 900)) }).toEqual({ field, ok: true })
    }
  })

  test('turning either off is not delayed by the ingest cache', () => {
    expect(analytics).toContain('resetRegionSiteCache(String(siteId))')
  })

  test('the region and city opt-ins are the site owner\'s call, not an admin\'s', () => {
    // The rest of PATCH /api/sites/{siteId} is admin-gated configuration. These
    // fields change what is recorded about visitors, so they re-check for owner.
    for (const field of ['regionGeo', 'cityGeo']) {
      const patch = analytics.slice(analytics.indexOf(`body.${field} !== undefined`))
      expect({ field, owner: patch.slice(0, 600).includes('requireSiteOwner(request, siteId)') }).toEqual({ field, owner: true })
    }
  })

  test('geo.ts reads the first subdivision and the city NAME, nothing finer', () => {
    // subdivisions[1] and beyond are counties and districts. `location` carries
    // latitude, longitude and an accuracy radius, and `postal` a postcode. None
    // of them is read, at any setting.
    const geo = read('app/Analytics/geo.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(geo).toContain('subdivisions?.[0]')
    expect(geo).not.toMatch(/subdivisions\??\.\[[1-9]/)
    expect(geo).toContain('city?.names?.en')
    expect(geo).not.toMatch(/\blocation\b|latitude|longitude|accuracy_radius|\bpostal\b/)
  })
})

describe('guardrail: no individual-tracking dependencies', () => {
  test('no session-replay / heatmap / fingerprint / profiling libraries are declared', () => {
    const forbidden = ['rrweb', 'heatmap', 'session-replay', 'fingerprint', 'mixpanel', 'amplitude', 'hotjar', 'fullstory']
    for (const dep of forbidden)
      expect(pkg.toLowerCase()).not.toContain(dep)
  })
})

describe('guardrail: visitor hash is rotating, per-site and opaque', () => {
  // These used to pass a Date and let hashVisitor derive the salt from it. The
  // salt is now a per-site-per-day secret supplied by app/Analytics/salt.ts
  // (#9), because a date-derived salt is public and made the digest a
  // confirmation oracle. The properties below are unchanged; what rotates the
  // salt daily is now the salt module, covered in visitor-salt-privacy.test.ts.
  const saltFor = (day: string) => `secret-for-${day}`

  test('rotates every 24h — no cross-day linkability', () => {
    const day1 = hashVisitor('1.2.3.4', 'UA', 'site', saltFor('2026-01-01'))
    const day2 = hashVisitor('1.2.3.4', 'UA', 'site', saltFor('2026-01-02'))
    expect(day1).not.toBe(day2)
  })

  test('is stable within a single UTC day', () => {
    const salt = saltFor('2026-01-01')
    const early = hashVisitor('1.2.3.4', 'UA', 'site', salt)
    const late = hashVisitor('1.2.3.4', 'UA', 'site', salt)
    expect(early).toBe(late)
  })

  test('is per-site — the same person on two sites gets two ids (no cross-site identity)', () => {
    const salt = saltFor('2026-01-01')
    const a = hashVisitor('1.2.3.4', 'UA', 'siteA', salt)
    const b = hashVisitor('1.2.3.4', 'UA', 'siteB', salt)
    expect(a).not.toBe(b)
  })

  test('is opaque — never leaks the raw IP or user-agent', () => {
    const ip = '203.0.113.7'
    const ua = 'Mozilla/5.0 SecretAgent'
    const h = hashVisitor(ip, ua, 'site', saltFor('2026-01-01'))
    expect(h).not.toContain(ip)
    expect(h).not.toContain('SecretAgent')
    expect(h).toMatch(/^[a-f0-9]{32}$/)
  })
})
