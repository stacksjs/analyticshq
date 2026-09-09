/**
 * Region geolocation: the disclosure floor, and the gates that keep it off.
 *
 * Country-only was an unconditional invariant (#7). Region is now reachable, and
 * everything that made loosening it acceptable is asserted here or in
 * `privacy-guardrails.test.ts`: three independent gates, a per-row floor that
 * the country breakdown does not need, and a city that is still unreachable.
 *
 * The fold is tested as a real imported function rather than through either of
 * its callers. It used to be written twice — once in the endpoint, once in the
 * dashboard's server block — which is two spellings of one threshold and would
 * have shown one figure in the panel and another through the API for the same
 * site on the same day.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import privacy from '../../config/privacy'
import { foldRegions, REGION_CODE, splitRegion } from '../../app/Analytics/regions'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** `visitors` drives the floor; `views` only has to be carried along correctly. */
const row = (region: string, visitors: number, views = visitors * 2) => ({ region, visitors, views })

describe('the compound ISO code', () => {
  test('splits into country and subdivision', () => {
    expect(splitRegion('US-CA')).toEqual({ country: 'US', subdivision: 'CA' })
    expect(splitRegion('GB-ENG')).toEqual({ country: 'GB', subdivision: 'ENG' })
  })

  test('rejects anything that is not one, rather than guessing', () => {
    // The dashboard builds a flag from the first two characters. Handing it a
    // bare 'CA' would render the Canadian flag beside a Californian row.
    for (const bad of ['CA', 'US', '', 'US-', '-CA', 'us-ca', 'USA-CA', 'US-CALI', null, undefined])
      expect({ bad, out: splitRegion(bad as string) }).toEqual({ bad, out: null })
  })

  test('the pattern is the one the column is sized for', () => {
    // varchar(6): two, a separator, and up to three.
    for (const code of ['US-CA', 'GB-ENG', 'JP-13'])
      expect({ code, ok: REGION_CODE.test(code), fits: code.length <= 6 }).toEqual({ code, ok: true, fits: true })
  })
})

describe('the disclosure floor folds small states into one bucket', () => {
  test('rows at or above the floor are named, rows below it are not', () => {
    const out = foldRegions([row('US-CA', 12), row('US-NY', 5), row('US-WY', 4), row('GB-ENG', 1)], 5, 20)
    expect(out.rows.map(r => r.region)).toEqual(['US-CA', 'US-NY'])
    expect(out.withheld).toBe(2)
    // 4 + 1 visitors, and their views carried with them.
    expect(out.other).toEqual({ views: 10, visitors: 5 })
  })

  test('the floor is a minimum, not a strict greater-than', () => {
    // Exactly k is allowed to be named — that is what k-anonymity means, and an
    // off-by-one here would withhold a row the policy permits.
    const out = foldRegions([row('US-CA', 5)], 5, 20)
    expect(out.rows.map(r => r.region)).toEqual(['US-CA'])
    expect(out.other).toBeNull()
  })

  test('nothing under the floor means no bucket at all', () => {
    // An "Other: 0" row would be a permanent, meaningless line on every panel.
    const out = foldRegions([row('US-CA', 40), row('US-NY', 9)], 5, 20)
    expect(out.other).toBeNull()
    expect(out.withheld).toBe(0)
  })

  test('the floor is applied BEFORE the limit, so the bucket counts everything', () => {
    // The bug this order prevents: cutting to the top N first would sum the
    // withheld total from those N and silently under-report it. Twelve tiny
    // rows, a limit of 2 — all twelve must reach the bucket.
    const rows = [row('US-CA', 50), row('US-NY', 40), ...Array.from({ length: 12 }, (_, i) => row(`US-${i}`, 1))]
    const out = foldRegions(rows, 5, 2)
    expect(out.rows.map(r => r.region)).toEqual(['US-CA', 'US-NY'])
    expect(out.withheld).toBe(12)
    expect(out.other).toEqual({ views: 24, visitors: 12 })
  })

  test('a floor of 0 disables the fold, matching minSegmentSize', () => {
    // Only an explicit 0 turns the guard off — the same rule config/privacy.ts
    // applies, where anything unset or malformed means "use the default".
    const out = foldRegions([row('US-WY', 1)], 0, 20)
    expect(out.rows.map(r => r.region)).toEqual(['US-WY'])
    expect(out.other).toBeNull()
  })

  test('null and empty regions are dropped, never folded into Other', () => {
    // A null region is a visit recorded before the site opted in, or one the
    // database could not place. It is not a withheld small state, and counting
    // it as one would inflate the bucket with traffic that has no region at all.
    const out = foldRegions([{ region: null, views: 99, visitors: 99 }, row('US-CA', 9)], 5, 20)
    expect(out.rows.map(r => r.region)).toEqual(['US-CA'])
    expect(out.other).toBeNull()
  })

  test('string counts from the driver are coerced, not concatenated', () => {
    // Postgres COUNT(*) comes back as a string through some drivers. '4' + '1'
    // is '41', which would report a bucket larger than the site.
    const out = foldRegions(
      [{ region: 'US-WY', views: '4', visitors: '4' }, { region: 'GB-ENG', views: '1', visitors: '1' }],
      5,
      20,
    )
    expect(out.other).toEqual({ views: 5, visitors: 5 })
  })
})

describe('both callers apply the same floor, from the same place', () => {
  const routes = read('routes/analytics.ts')
  const view = read('resources/views/dashboard.stx')

  test('neither one re-implements the fold', () => {
    for (const [name, src] of [['routes', routes], ['dashboard', view]] as const) {
      expect({ name, imports: src.includes('foldRegions') }).toEqual({ name, imports: true })
      // The tell of a second implementation: its own accumulator.
      expect({ name, own: /otherVisitors\s*\+=/.test(src) }).toEqual({ name, own: false })
    }
  })

  test('the threshold is the configured one in both, not a literal', () => {
    expect(routes).toContain('foldRegions(')
    expect(routes).toMatch(/foldRegions\([\s\S]{0,400}privacy\.minSegmentSize/)
    expect(view).toContain('privacy.minSegmentSize')
    expect(view).toContain('foldRegions(regions, REGION_FLOOR')
  })

  test('the regions query is the only breakdown with no SQL limit', () => {
    // Because the fold has to see every row. The others keep their LIMIT.
    const regionQuery = view.slice(view.indexOf('regions = (await pgq('), view.indexOf('regions = (await pgq(') + 400)
    expect(regionQuery).toContain('GROUP BY region ORDER BY views DESC`')
    expect(regionQuery).not.toMatch(/GROUP BY region[\s\S]{0,60}LIMIT/)
  })

  test('the endpoint asks for regions with the floor switched on', () => {
    expect(routes).toContain("topDimension('/api/sites/{siteId}/regions', 'region', 'regions', { floorRows: true })")
    // And no other dimension does: country deliberately has no per-row floor.
    const others = [...routes.matchAll(/topDimension\('[^']+', '(\w+)'[^)]*floorRows/g)].map(m => m[1])
    expect(others).toEqual(['region'])
  })
})

describe('the dashboard panel is off until a site turns it on', () => {
  const view = read('resources/views/dashboard.stx')

  test('the panel is behind a server @if on the site setting', () => {
    // Not a :show. A site that never opted in has no region values at all and
    // should not grow a permanently empty card.
    expect(view).toContain('@if (regionGeo)')
    expect(view).toMatch(/@if \(regionGeo\)[\s\S]{0,400}BreakdownPanel title="Top regions"/)
  })

  test('the toggle is :checked + @change, never x-model', () => {
    // x-model would own the value, and the value is the server's until a request
    // succeeds — an optimistic tick that then failed would leave the box saying
    // yes about a site recording nothing.
    const toggle = view.slice(view.indexOf('Record state and province'))
    const input = toggle.slice(toggle.indexOf('<input type="checkbox"'), toggle.indexOf('<input type="checkbox"') + 200)
    expect(input).toContain(':checked="regionGeoOn()"')
    expect(input).toContain('@change="toggleRegionGeo"')
    expect(input).not.toContain('x-model')
  })

  test('the signal follows the server and never leads it', () => {
    // regionGeoOn.set is reached only after res.ok, so a refusal leaves the box
    // describing what the site is actually recording.
    const fn = view.slice(view.indexOf('async function toggleRegionGeo'), view.indexOf('// --- Fathom import'))
    expect(fn).toMatch(/if \(res\.ok\) \{\s*\n\s*regionGeoOn\.set\(next\)/)
  })

  test('an install that does not permit regions explains itself', () => {
    // Rather than offering a switch the endpoint answers 409 to.
    const panel = view.slice(view.indexOf('Record state and province'))
    expect(panel.slice(0, 2000)).toContain('@if (regionGeoAllowed)')
    expect(panel.slice(0, 2000)).toContain('Not enabled on this server')
  })

  test('the copy tells the truth about what the floor does', () => {
    const panel = view.slice(view.indexOf('Record state and province'), view.indexOf('Share this dashboard'))
    expect(panel).toContain('never a city')
    expect(panel).toContain('REGION_FLOOR')
  })
})

describe('the default posture is unchanged for everyone who does nothing', () => {
  test('the ceiling permits region, and a site still has to ask', () => {
    // "Default" is two settings here and only one of them moved. The install
    // permits region so a site owner can switch it on unaided; the site itself
    // is off until they do, which is why the recorded default is still country
    // and why the comparison pages did not have to change again.
    expect(privacy.geo.granularity).toBe('region')
    const sql = read('database/migrations/0000000051-add-opt-in-region-geo.sql')
    expect(sql).toContain('"region_geo" boolean NOT NULL DEFAULT false')
    // Nothing backfills the flag onto sites that already exist.
    expect(sql).not.toMatch(/UPDATE\s+"?sites"?\s+SET/i)
  })

  test('the migration defaults the site column to false and is idempotent', () => {
    const sql = read('database/migrations/0000000051-add-opt-in-region-geo.sql')
    expect(sql).toContain('"region_geo" boolean NOT NULL DEFAULT false')
    // Every statement re-runnable: the runner has no notion of partial application.
    for (const stmt of sql.split(';').filter(s => /ALTER TABLE|CREATE INDEX/.test(s)))
      expect(stmt).toMatch(/IF NOT EXISTS/)
  })

  test('the models declare the columns, so the schema differ leaves them alone', () => {
    // buddy migrate runs a differ that compares the live tables against these
    // attributes. A column present in the database and absent from the models is
    // one it proposes DROPPING on every deploy -- that is what refused three
    // deploys in a row on 2026-08-23, per the note in config/cloud.ts.
    //
    // The raw migration creates the columns; these declarations are what stop
    // the next deploy asking to take them away again.
    for (const [file, column, width] of [
      ['app/Models/PageView.ts', 'region', 6],
      ['app/Models/Session.ts', 'region', 6],
    ] as const) {
      const src = read(file)
      expect({ file, declared: src.includes(`${column}: { fillable: true`) }).toEqual({ file, declared: true })
      // The width has to match the migration, or the differ proposes an ALTER
      // on every deploy instead of a drop.
      expect({ file, width: src.includes(`.max(${width})`) }).toEqual({ file, width: true })
    }
    expect(read('app/Models/Site.ts')).toContain('region_geo: {')
  })

  test('the column is sized for the compound code and nothing longer', () => {
    const sql = read('database/migrations/0000000051-add-opt-in-region-geo.sql')
    expect(sql).toContain('"region" varchar(6)')
    // A city name would not fit in six characters. That is not the guard against
    // one — privacy-guardrails.test.ts is — but it is a second lock on the door.
    expect(sql).not.toMatch(/varchar\(\s*(?:[7-9]\d*|\d{3,})\s*\)/)
  })
})
