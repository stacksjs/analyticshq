/**
 * Privacy guardrails — executable invariants.
 *
 * analyticshq is an aggregate-only, cookieless analytics product. These tests
 * fail CI the moment the code drifts toward individual-level tracking, so the
 * privacy contract in PRIVACY.md can't silently regress. See issue #28.
 *
 * They assert against the real tracker/ingest source and package manifest — not
 * a mock — so any PR that adds cookies, stores a raw IP, turns on city geo, or
 * pulls in a session-replay/heatmap library trips a red test.
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

describe('guardrail: no city, and region only when asked for twice', () => {
  test('the ingest never populates a city, at any granularity', () => {
    // This is the half of issue #7 that did not move. Region became reachable as
    // an opt-in; city did not, and there is no setting, database read or code
    // path that reaches one. A populated `city:` key here would take us below
    // the line /compare/plausible and /compare/umami still claim.
    expect(analytics).not.toMatch(/^\s*city\s*:/m)
  })

  test('the schema carries no city column', () => {
    const files = [
      'database/migrations/0000000003-create-page_views-table.sql',
      'database/migrations/0000000005-create-sessions-table.sql',
      'database/migrations/0000000051-add-opt-in-region-geo.sql',
      'app/Models/PageView.ts',
      'app/Models/Session.ts',
    ]
    for (const f of files) {
      const src = read(f)
      expect(src).not.toMatch(/["\s]city["\s]*(varchar|:)/i)
    }
  })

  test('region is written only when the install permits it and the site asked', () => {
    // The guardrail that replaces "no region column, ever". Two independent
    // gates, and this pins that neither was collapsed into the other: an
    // instance check that returns before any query, and a per-site flag.
    expect(analytics).toMatch(/privacy\.geo\.granularity !== 'region'\s*\)?\s*\n?\s*return false/)
    expect(analytics).toContain('siteWantsRegion')
    // The region value never comes from anywhere but the subdivision lookup.
    expect(analytics).toMatch(/region\s*=\s*\(await siteWantsRegion\([\s\S]{0,40}\?\s*regionFromIp/)
  })

  test('a site cannot opt in on an install that does not permit it', () => {
    // Refused with a 409 rather than stored: a setting that saves, reads back as
    // on and records nothing sends the owner debugging their snippet.
    const patch = analytics.slice(analytics.indexOf('body.regionGeo !== undefined'))
    expect(patch.slice(0, 900)).toMatch(/granularity !== 'region'[\s\S]{0,400}409/)
  })

  test('turning region off is not delayed by the ingest cache', () => {
    expect(analytics).toContain('resetRegionSiteCache(String(siteId))')
  })

  test('the region opt-in is the site owner\'s call, not an admin\'s', () => {
    // The rest of PATCH /api/sites/{siteId} is admin-gated configuration. This
    // field changes what is recorded about visitors, so it re-checks for owner.
    const patch = analytics.slice(analytics.indexOf('body.regionGeo !== undefined'))
    expect(patch.slice(0, 600)).toContain('requireSiteOwner(request, siteId)')
  })

  test('geo.ts reads the first subdivision and nothing below it', () => {
    // subdivisions[1] and beyond are counties and districts — a granularity
    // nobody opted into, under a setting that says region.
    const geo = read('app/Analytics/geo.ts')
    expect(geo).toContain('subdivisions?.[0]')
    expect(geo).not.toMatch(/subdivisions\??\.\[[1-9]/)
    expect(geo).not.toMatch(/\bcity\b\s*[?.]/)
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
