/**
 * The dashboard shows times in the reader's own timezone, and the active range
 * tab stays highlighted.
 *
 * Both came from one screenshot: a reader in Los Angeles at 2:58pm saw a spike
 * labelled 21:00 (the chart bucketed in UTC), and the 24h tab was not
 * highlighted while showing "Last 24 hours".
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tzCookie, validTimeZone, zonedKey, zoneLabel } from '../../app/Support/timezone'
import { stamp } from '../../app/Support/visitor-format'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('the reader\'s zone', () => {
  test('keys are the local wall clock, in the shape Postgres buckets by', () => {
    const at = new Date('2026-09-25T21:58:00Z')
    expect(zonedKey(at, 'UTC')).toBe('2026-09-25T21:58:00')
    expect(zonedKey(at, 'America/Los_Angeles')).toBe('2026-09-25T14:58:00')
    expect(zonedKey(at, 'Asia/Kolkata')).toBe('2026-09-26T03:28:00')
    // Midnight is 00, never 24 (hourCycle h23).
    expect(zonedKey(new Date('2026-09-26T07:00:00Z'), 'America/Los_Angeles')).toBe('2026-09-26T00:00:00')
  })

  test('labels are the short zone name', () => {
    expect(zoneLabel('UTC')).toBe('UTC')
    expect(zoneLabel('America/Los_Angeles', new Date('2026-09-25T21:58:00Z'))).toBe('PDT')
    expect(zoneLabel('America/Los_Angeles', new Date('2026-01-15T21:58:00Z'))).toBe('PST')
  })

  test('only a real IANA name gets through, since it is interpolated into SQL', () => {
    expect(validTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles')
    expect(validTimeZone('Etc/GMT+8')).toBe('Etc/GMT+8')
    for (const bad of ['', 'Not/AZone', `UTC'); DROP TABLE sites; --`, 'America/Los Angeles', '../../etc', null, 42, {}])
      expect(validTimeZone(bad)).toBe(null)
  })

  test('the cookie is a site-wide display preference', () => {
    expect(tzCookie('America/Los_Angeles', true)).toBe('tz=America%2FLos_Angeles; Path=/; Max-Age=31536000; SameSite=Lax; Secure')
    expect(tzCookie('UTC', false)).not.toContain('Secure')
  })

  test('the visitor page reads the same way', () => {
    expect(stamp('2026-09-25T21:58:00Z', 'America/Los_Angeles')).toBe('Sep 25, 14:58 PDT')
    expect(stamp('2026-09-25T21:58:00Z')).toBe('Sep 25, 21:58 UTC')
  })
})

describe('the dashboard wiring', () => {
  const dash = read('resources/views/dashboard.stx')
  const routes = read('routes/analytics.ts')

  test('the chart buckets and fills in the same zone', () => {
    // Filling empty buckets with UTC keys while the query bucketed in local time
    // would leave every bucket unmatched for a reader outside UTC.
    expect(dash).toContain(`to_char(timezone('\${chartTz}', timestamp::timestamptz)`)
    const densify = dash.slice(dash.indexOf('function densify('), dash.indexOf('const chart = buildChart('))
    expect(densify).toContain('zonedKey(new Date(t), chartTz)')
    expect(densify).toContain('zonedKey(new Date(fromISO), chartTz)')
  })

  test('the reader\'s zone is checked against Postgres before it is used', () => {
    expect(dash).toContain('SELECT now() AT TIME ZONE ?')
    expect(dash.indexOf('SELECT now() AT TIME ZONE ?')).toBeLessThan(dash.indexOf('chartTz = savedTz'))
  })

  test('the browser reports its zone once, and cannot loop', () => {
    expect(dash).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone')
    expect(dash).toContain('browserTz !== savedTz')
    expect(dash).toContain('defineClientPayload({ activeSiteId, chartTz,')
  })

  test('the endpoint validates before it sets anything', () => {
    const i = routes.indexOf(`route.post('/api/prefs/timezone'`)
    const b = routes.slice(i, routes.indexOf('\nroute.', i + 10))
    expect(b.indexOf('validTimeZone(body.tz)')).toBeLessThan(b.indexOf('Set-Cookie'))
    expect(b).toContain('}, 400)')
  })

  test('the active range is marked in a way the router leaves alone', () => {
    // The stx router strips aria-current="page" from any link whose href is not
    // the current pathname, and these hrefs are query-only.
    expect(dash).toContain(`aria-current="{{ !isCustom && r.key === range ? 'true' : 'false' }}"`)
    expect(dash).toContain('.range-link[aria-current="true"]')
    expect(dash).not.toContain('.range-link[aria-current="page"]')
  })
})
