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

describe('guardrail: country-only geolocation', () => {
  test('the ingest populates country only — never city or region', () => {
    // page_views/sessions carry country only; city/region must stay null.
    // A populated `city:`/`region:` object key here would regress us below the
    // country-only line (stricter than Plausible/Fathom). See issue #7.
    expect(analytics).not.toMatch(/^\s*city\s*:/m)
    expect(analytics).not.toMatch(/^\s*region\s*:/m)
  })

  test('the schema and models carry no city/region columns', () => {
    // The columns were removed (issue #7) so the sub-country capability cannot be
    // quietly switched on. Re-adding a region/city column trips this guardrail.
    const files = [
      'database/migrations/0000000003-create-page_views-table.sql',
      'database/migrations/0000000005-create-sessions-table.sql',
      'app/Models/PageView.ts',
      'app/Models/Session.ts',
    ]
    for (const f of files) {
      const src = read(f)
      expect(src).not.toMatch(/["\s](city|region)["\s]*(varchar|:)/i)
    }
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
  const at = (iso: string) => new Date(iso)

  test('rotates every 24h — no cross-day linkability', () => {
    const day1 = hashVisitor('1.2.3.4', 'UA', 'site', at('2026-01-01T12:00:00Z'))
    const day2 = hashVisitor('1.2.3.4', 'UA', 'site', at('2026-01-02T12:00:00Z'))
    expect(day1).not.toBe(day2)
  })

  test('is stable within a single UTC day', () => {
    const early = hashVisitor('1.2.3.4', 'UA', 'site', at('2026-01-01T00:00:01Z'))
    const late = hashVisitor('1.2.3.4', 'UA', 'site', at('2026-01-01T23:59:59Z'))
    expect(early).toBe(late)
  })

  test('is per-site — the same person on two sites gets two ids (no cross-site identity)', () => {
    const a = hashVisitor('1.2.3.4', 'UA', 'siteA', at('2026-01-01T12:00:00Z'))
    const b = hashVisitor('1.2.3.4', 'UA', 'siteB', at('2026-01-01T12:00:00Z'))
    expect(a).not.toBe(b)
  })

  test('is opaque — never leaks the raw IP or user-agent', () => {
    const ip = '203.0.113.7'
    const ua = 'Mozilla/5.0 SecretAgent'
    const h = hashVisitor(ip, ua, 'site', at('2026-01-01T12:00:00Z'))
    expect(h).not.toContain(ip)
    expect(h).not.toContain('SecretAgent')
    expect(h).toMatch(/^[a-f0-9]{32}$/)
  })
})
