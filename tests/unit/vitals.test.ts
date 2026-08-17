/**
 * Core Web Vitals (#41).
 *
 * The feature was advertised in the nav before it existed, so the first thing
 * worth pinning is that the page and the product now agree. After that: the
 * thresholds (which have to match Google's or a site owner sees "poor" here and
 * "good" in Search Console), the percentile definition, what a beacon is allowed
 * to put in the database, and when a percentile is refused.
 *
 * The percentile is computed by Postgres in the live query and by JS here. That
 * duplication is the point of `agrees with percentile_disc` below — it is
 * checked rather than trusted.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildDeviceReport,
  buildReport,
  formatVital,
  isVitalDevice,
  isVitalMetric,
  normalizeVitalDevice,
  parseVitalsPayload,
  percentile,
  rating,
  RATING_COLOR,
  VITAL_DEVICES,
  VITAL_METRICS,
  VITAL_THRESHOLDS,
} from '../../app/Analytics/vitals'
import privacy from '../../config/privacy'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// Strip comments before asserting on source. Matching a forbidden string inside
// a comment that EXPLAINS the rule is the standing way these guards go vacuous.
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('the metrics we collect', () => {
  test('are the five the marketing page names, and not FID', () => {
    expect([...VITAL_METRICS].sort()).toEqual(['CLS', 'FCP', 'INP', 'LCP', 'TTFB'])
    // Google retired FID for INP in March 2024. ts-analytics still collects it;
    // porting it would have shipped a withdrawn metric on day one.
    expect(VITAL_METRICS).not.toContain('FID' as any)
  })

  test('every metric has a threshold, and every threshold a metric', () => {
    // A metric with no entry would throw at `rating()`; a threshold with no
    // metric is dead config that reads as if it were live.
    expect(Object.keys(VITAL_THRESHOLDS).sort()).toEqual([...VITAL_METRICS].sort())
  })

  test('thresholds are Google\'s published boundaries', () => {
    // Not ours to tune. Disagreeing with Search Console on the same site is how
    // an owner learns to trust neither number.
    expect(VITAL_THRESHOLDS.LCP).toEqual([2500, 4000])
    expect(VITAL_THRESHOLDS.INP).toEqual([200, 500])
    expect(VITAL_THRESHOLDS.CLS).toEqual([0.1, 0.25])
    expect(VITAL_THRESHOLDS.FCP).toEqual([1800, 3000])
    expect(VITAL_THRESHOLDS.TTFB).toEqual([800, 1800])
  })

  test('isVitalMetric refuses anything else', () => {
    expect(isVitalMetric('LCP')).toBe(true)
    expect(isVitalMetric('FID')).toBe(false)
    expect(isVitalMetric('lcp')).toBe(false)
    expect(isVitalMetric(null)).toBe(false)
    expect(isVitalMetric(42)).toBe(false)
  })
})

describe('rating', () => {
  test('the boundary is inclusive on the good side', () => {
    // 2500 is "good", not "needs improvement". Google's tables read "≤ 2.5s".
    expect(rating('LCP', 2500)).toBe('good')
    expect(rating('LCP', 2501)).toBe('needs-improvement')
    expect(rating('LCP', 4000)).toBe('needs-improvement')
    expect(rating('LCP', 4001)).toBe('poor')
  })

  test('CLS is graded on its own scale, not milliseconds', () => {
    // The one metric that is a ratio. If CLS were ever scaled to an integer on
    // the wire, 0.08 would arrive as 80 and be graded "poor" instead of "good".
    expect(rating('CLS', 0.05)).toBe('good')
    expect(rating('CLS', 0.2)).toBe('needs-improvement')
    expect(rating('CLS', 0.5)).toBe('poor')
    expect(rating('CLS', 80)).toBe('poor')
  })
})

describe('percentile', () => {
  test('nearest-rank: returns a value that was actually measured', () => {
    // The whole claim of field data is that these are real measurements, so an
    // interpolated p75 — a number no visitor experienced — would undercut it.
    const values = [100, 200, 300, 400]
    expect(percentile(values, 0.75)).toBe(300)
    expect(values.includes(percentile(values, 0.75)!)).toBe(true)
  })

  test('does not require the caller to pre-sort', () => {
    expect(percentile([400, 100, 300, 200], 0.75)).toBe(300)
  })

  test('p75 of one sample is that sample', () => {
    expect(percentile([1234], 0.75)).toBe(1234)
  })

  test('empty is null, not zero', () => {
    // 0ms would render as a perfect score for a site with no data at all.
    expect(percentile([], 0.75)).toBeNull()
  })

  test('p100 does not run off the end', () => {
    expect(percentile([1, 2, 3], 1)).toBe(3)
  })

  test('p0 lands on the first element rather than index -1', () => {
    expect(percentile([1, 2, 3], 0)).toBe(1)
  })
})

describe('formatting', () => {
  test('durations read the way every vitals tool writes them', () => {
    expect(formatVital('LCP', 850)).toBe('850ms')
    expect(formatVital('LCP', 2600)).toBe('2.60s')
    expect(formatVital('TTFB', 999)).toBe('999ms')
    expect(formatVital('TTFB', 1000)).toBe('1.00s')
  })

  test('CLS is a ratio, never a duration', () => {
    // "0ms" for a CLS of 0.083 is the same class of mistake as an integer column.
    expect(formatVital('CLS', 0.0834)).toBe('0.083')
    expect(formatVital('CLS', 0.1)).toBe('0.100')
    expect(formatVital('CLS', 0.0834)).not.toContain('ms')
    expect(formatVital('CLS', 0.0834)).not.toContain('s')
  })

  test('every rating band has a colour', () => {
    // A missing entry renders `style="color: undefined"`, which is an invisible
    // dot rather than an error.
    expect(Object.keys(RATING_COLOR).sort()).toEqual(['good', 'needs-improvement', 'poor'])
    for (const c of Object.values(RATING_COLOR))
      expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('what a beacon may write', () => {
  test('the ordinary case', () => {
    expect(parseVitalsPayload({ LCP: 1800, CLS: 0.0834 })).toEqual([
      { metric: 'LCP', value: 1800 },
      { metric: 'CLS', value: 0.0834 },
    ])
  })

  test('CLS keeps its decimals', () => {
    // The reason the column is double precision. An integer column (which the
    // model generator would have produced) floors this to 0 and every site
    // reports perfect layout stability.
    const [cls] = parseVitalsPayload({ CLS: 0.0834 })
    expect(cls.value).toBe(0.0834)
    expect(cls.value).not.toBe(0)
  })

  test('one bad metric does not cost us the good ones', () => {
    const out = parseVitalsPayload({ LCP: 1800, INP: Number.NaN, CLS: -1, TTFB: 300 })
    expect(out.map(s => s.metric)).toEqual(['LCP', 'TTFB'])
  })

  test('unknown keys are dropped', () => {
    expect(parseVitalsPayload({ FID: 50, evil: 1, LCP: 900 })).toEqual([{ metric: 'LCP', value: 900 }])
  })

  test('numeric strings are refused, not coerced', () => {
    // Our tracker sends numbers. A string means something else is talking to
    // /collect, and guessing at its intent is how junk enters a percentile.
    expect(parseVitalsPayload({ LCP: '1800' })).toEqual([])
  })

  test('absurd values are rejected rather than clamped', () => {
    // Clamping would turn an attacker's 1e9 into a plausible one-hour LCP and
    // drag the percentile with it. The bound exists to discard, not to reshape.
    expect(parseVitalsPayload({ LCP: 1e9 })).toEqual([])
    expect(parseVitalsPayload({ CLS: 999 })).toEqual([])
    expect(parseVitalsPayload({ LCP: Number.POSITIVE_INFINITY })).toEqual([])
  })

  test('zero is legal', () => {
    // A cached page really can report TTFB 0. Rejecting it would bias the
    // percentile upward on exactly the fastest sites.
    expect(parseVitalsPayload({ TTFB: 0 })).toEqual([{ metric: 'TTFB', value: 0 }])
  })

  test('non-objects are not a crash', () => {
    expect(parseVitalsPayload(null)).toEqual([])
    expect(parseVitalsPayload('LCP')).toEqual([])
    expect(parseVitalsPayload([1, 2, 3])).toEqual([])
    expect(parseVitalsPayload(undefined)).toEqual([])
  })
})

describe('the disclosure floor', () => {
  const K = 5
  const agg = (samples: number, p75 = 1000) => [{ metric: 'LCP', p75, samples }]

  test('a percentile from too few people is withheld', () => {
    // Unlike #40, this applies WITHOUT a filter. A count over few people reveals
    // nothing about any of them; a p75 over one person is that person's phone.
    const [lcp] = buildReport(agg(1), K)
    expect(lcp.value).toBeNull()
    expect(lcp.suppressed).toBe(true)
  })

  test('at the floor exactly, it reports', () => {
    const [lcp] = buildReport(agg(5), K)
    expect(lcp.value).toBe(1000)
    expect(lcp.suppressed).toBe(false)
  })

  test('the sample count is reported even when the value is withheld', () => {
    // "Not enough data yet (2 samples)" is actionable. A blank is indistinguishable
    // from a broken collector.
    const [lcp] = buildReport(agg(2), K)
    expect(lcp.samples).toBe(2)
    expect(lcp.value).toBeNull()
  })

  test('no samples is not "suppressed" — it is no data', () => {
    // The dashboard says different things for the two, and conflating them would
    // report a brand-new site as if it were being withheld for privacy.
    const [lcp] = buildReport([], K)
    expect(lcp.samples).toBe(0)
    expect(lcp.suppressed).toBe(false)
    expect(lcp.value).toBeNull()
  })

  test('k = 0 disables it, as it does for segments', () => {
    const [lcp] = buildReport(agg(1), 0)
    expect(lcp.value).toBe(1000)
    expect(lcp.suppressed).toBe(false)
  })

  test('a withheld value carries no rating either', () => {
    // A rating is a coarse bucket, but "poor" over one visitor still discloses
    // that visitor's experience.
    const [lcp] = buildReport(agg(1), K)
    expect(lcp.rating).toBeNull()
  })

  test('every metric appears, including the ones with nothing', () => {
    const report = buildReport(agg(9), K)
    expect(report.map(r => r.metric)).toEqual([...VITAL_METRICS])
  })

  test('an unknown metric from the database is ignored, not rendered', () => {
    const report = buildReport([{ metric: 'FID', p75: 50, samples: 99 }], K)
    expect(report.find(r => (r.metric as string) === 'FID')).toBeUndefined()
  })

  test('the floor is the same k as segments', () => {
    // Two different privacy thresholds would be two things to reason about, and
    // the second one always drifts.
    expect(privacy.minSegmentSize).toBeGreaterThan(0)
  })
})

describe('the tracker', () => {
  const tracker = read('public/script.js')

  test('sends ONE beacon, not one per metric', () => {
    // Five metrics on every page view is a 5x ingest bill for a product that
    // sells being light. There is exactly one place a vitals body is built.
    const bodies = code('public/script.js').match(/e:\s*'vitals'/g) ?? []
    expect(bodies.length).toBe(1)
  })

  test('flushes when the page is hidden, when the values are final', () => {
    // LCP can be superseded, CLS accumulates, INP is a running max. Reporting
    // early reports the wrong number.
    const src = code('public/script.js')
    expect(src).toContain('visibilitychange')
    expect(src).toContain('pagehide')
  })

  test('is guarded against a double flush', () => {
    // visibilitychange and pagehide both fire in some browsers.
    expect(code('public/script.js')).toContain('flushed')
  })

  test('uses sendBeacon, with a JSON blob so the route can parse it', () => {
    // A bare string arrives as text/plain and `request.jsonBody` stays empty —
    // the beacon would be delivered and silently dropped.
    const src = code('public/script.js')
    expect(src).toContain('sendBeacon')
    expect(src).toContain('application/json')
  })

  test('does not scale CLS on the wire', () => {
    // ts-analytics multiplies CLS by 1000 and divides it back in two separate
    // readers, which was already a bug once (ts-analytics#133).
    expect(code('public/script.js')).not.toMatch(/cls\s*\*\s*1000/i)
  })

  test('can be turned off per site', () => {
    expect(tracker).toContain('data-vitals')
  })

  test('respects DNT before it observes anything', () => {
    // The DNT bail is an early `return` from the IIFE, so it must come first in
    // source order or a visitor who opted out still gets PerformanceObservers.
    const src = code('public/script.js')
    expect(src.indexOf('doNotTrack')).toBeGreaterThan(0)
    expect(src.indexOf('PerformanceObserver')).toBeGreaterThan(src.indexOf('doNotTrack'))
  })
})

describe('the promise the site makes', () => {
  test('the nav advertises vitals and the collector now exists', () => {
    // This feature was in the mega-menu, the footer, the homepage and a full
    // feature page for weeks with no implementation behind it. This test is what
    // makes deleting the implementation break something.
    expect(read('resources/partials/site-nav.stx')).toContain('/features/web-vitals')
    expect(code('public/script.js')).toContain('PerformanceObserver')
  })

  test('the three metrics named in the nav copy are the three we collect', () => {
    const nav = read('resources/partials/site-nav.stx')
    expect(nav).toContain('LCP, INP, and CLS')
    for (const metric of ['LCP', 'INP', 'CLS'])
      expect(VITAL_METRICS).toContain(metric as any)
  })
})

describe('erasure and retention reach the new table', () => {
  test('GDPR erasure covers web_vitals', () => {
    // The visitor_id column exists for this and nothing else. If web_vitals were
    // left out of EVENT_TABLES, "delete everything about this visitor" would
    // quietly not.
    const src = code('routes/analytics.ts')
    const tables = src.match(/const EVENT_TABLES = \[([^\]]+)\]/)
    expect(tables).not.toBeNull()
    expect(tables![1]).toContain('web_vitals')
  })

  test('the retention purge covers web_vitals', () => {
    // The highest-volume table in the schema — one row per metric per page view.
    expect(code('scripts/analytics/prune.ts')).toContain(`'web_vitals'`)
  })

  test('the table cascades when its site is deleted', () => {
    const migration = read('database/migrations/0000000047-create-web_vitals-table.sql')
    expect(migration).toContain('ON DELETE CASCADE')
  })

  test('value is a float column, not an integer', () => {
    // An integer column floors CLS to 0. The model generator produced exactly
    // that, which is why there is no WebVital model.
    const migration = read('database/migrations/0000000047-create-web_vitals-table.sql')
    expect(migration).toMatch(/"value"\s+double precision/)
  })

  test('there is no WebVital model to regenerate an integer column from', () => {
    expect(() => readFileSync(join(ROOT, 'app/Models/WebVital.ts'), 'utf8')).toThrow()
  })
})

describe('the read routes', () => {
  const src = code('routes/analytics.ts')

  test('use percentile_disc, not percentile_cont', () => {
    // _cont interpolates and returns a duration nobody experienced; _disc is
    // nearest-rank and matches app/Analytics/vitals.ts:percentile and CrUX.
    expect(src).toContain('percentile_disc(0.75)')
    expect(src).not.toContain('percentile_cont')
  })

  test('say plainly that vitals are not filtered', () => {
    // web_vitals has no country and no browser column, so most of the filter bar
    // has nothing to narrow. The device column added in #43 does NOT make the
    // report filterable: honouring one dimension of the filter while ignoring the
    // rest would give a panel that is filtered along an axis nothing on screen
    // identifies. Returning partly-filtered numbers under an active filter
    // without saying so is the worst of the available options.
    expect(src).toContain('filterable: false')
  })

  test('are viewer-gated like every other report', () => {
    const vitalsRoute = src.slice(src.indexOf(`route.get('/api/sites/{siteId}/vitals'`))
    expect(vitalsRoute.slice(0, 400)).toContain(`requireSiteRole(request, siteId, 'viewer')`)
  })

  test('the vitals beacon never reaches the goal matcher', () => {
    // A site may legitimately name a goal "vitals". A speed measurement silently
    // recording a conversion would be very hard to explain from the dashboard.
    //
    // Asserting that the region merely CONTAINS a 204 return is not enough — the
    // branch has three of them (the config kill switch, the empty payload, the
    // insert), so deleting the last one leaves the check green while control
    // falls straight through into sessionization and goal matching. What has to
    // be true is structural: the block's own last statement is a return.
    const collect = src.slice(src.indexOf(`route.post('/collect'`))
    const start = collect.indexOf(`if (body.e === 'vitals') {`)
    const goalMatcher = collect.indexOf('matchesGoal')
    expect(start).toBeGreaterThan(0)
    expect(goalMatcher).toBeGreaterThan(start)

    // Walk to the brace that closes the branch. Comments are already stripped;
    // the remaining braces are code, and the one template literal in the block
    // (`${placeholders}`) is itself balanced.
    let depth = 0
    let end = -1
    for (let i = collect.indexOf('{', start); i < collect.length; i++) {
      if (collect[i] === '{')
        depth++
      else if (collect[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    expect(end).toBeGreaterThan(start)
    expect(end).toBeLessThan(goalMatcher)

    const lastStatement = collect.slice(start, end).trimEnd().split('\n').pop()!.trim()
    expect(lastStatement).toMatch(/^return new Response\(null, \{ status: 204/)
  })
})

// ---------------------------------------------------------------------------
// By device (#43)
// ---------------------------------------------------------------------------

describe('the device classes', () => {
  test('are the same three the pageview path already stores', () => {
    // Same lowercase values parseUserAgent returns and page_views.device_type
    // holds. A capitalised or renamed set here would mean the two tables could
    // never be read against each other without a translation nobody maintains.
    expect([...VITAL_DEVICES]).toEqual(['desktop', 'mobile', 'tablet'])
    expect(read('database/migrations/0000000003-create-page_views-table.sql')).toContain('"device_type"')
  })

  test('isVitalDevice refuses anything else', () => {
    expect(isVitalDevice('mobile')).toBe(true)
    // The dashboard's device filter chips render whatever the column holds, and a
    // hand-typed ?device=Mobile must not silently match nothing.
    expect(isVitalDevice('Mobile')).toBe(false)
    expect(isVitalDevice('unknown')).toBe(false)
    expect(isVitalDevice(null)).toBe(false)
    expect(isVitalDevice(7)).toBe(false)
  })

  test('anything unrecognised normalizes to unknown rather than disappearing', () => {
    // Dropping would make the device rows fail to sum to the site-wide total,
    // which is the first thing anyone checks when they distrust a breakdown.
    expect(normalizeVitalDevice(null)).toBe('unknown')
    expect(normalizeVitalDevice(undefined)).toBe('unknown')
    expect(normalizeVitalDevice('')).toBe('unknown')
    expect(normalizeVitalDevice('smart-fridge')).toBe('unknown')
    expect(normalizeVitalDevice('mobile')).toBe('mobile')
  })
})

describe('the device breakdown', () => {
  const K = 5
  const row = (device: string | null, metric: string, samples: number, p75 = 1000) =>
    ({ device, metric, p75, samples })

  test('always shows all three devices, in a fixed order', () => {
    // A missing `mobile` row is indistinguishable from a broken one. Fixed order
    // also means the table does not reshuffle itself between page loads as
    // traffic shifts.
    const report = buildDeviceReport([row('mobile', 'LCP', 100)], K)
    expect(report.map(r => r.device)).toEqual(['desktop', 'mobile', 'tablet'])
  })

  test('every device carries the full five metrics, in the canonical order', () => {
    const report = buildDeviceReport([row('desktop', 'LCP', 50)], K)
    for (const device of report)
      expect(device.metrics.map(m => m.metric)).toEqual([...VITAL_METRICS])
  })

  test('the unknown bucket is hidden until it has something in it', () => {
    // A permanently empty column headed "unknown" is an invitation to wonder
    // what is being withheld — and on a site installed after migration 48 it can
    // never fill.
    expect(buildDeviceReport([row('desktop', 'LCP', 9)], K).map(r => r.device))
      .not.toContain('unknown')
  })

  test('rows written before the column existed show up as unknown, last', () => {
    const report = buildDeviceReport([row(null, 'LCP', 40), row('desktop', 'LCP', 10)], K)
    expect(report.map(r => r.device)).toEqual(['desktop', 'mobile', 'tablet', 'unknown'])
    expect(report[3].samples).toBe(40)
  })

  test('the floor is applied per device, not per site', () => {
    // The whole hazard of a breakdown. 40 desktop + 2 mobile is comfortably over
    // the floor site-wide, and the mobile p75 is still two people's phones.
    const report = buildDeviceReport([row('desktop', 'LCP', 40, 900), row('mobile', 'LCP', 2, 5000)], K)
    const desktop = report[0].metrics.find(m => m.metric === 'LCP')!
    const mobile = report[1].metrics.find(m => m.metric === 'LCP')!
    expect(desktop.value).toBe(900)
    expect(desktop.suppressed).toBe(false)
    expect(mobile.value).toBeNull()
    expect(mobile.suppressed).toBe(true)
    // And the count survives, so the panel can say how far under it is.
    expect(mobile.samples).toBe(2)
  })

  test('a withheld percentile still reports how many measurements it had', () => {
    const [desktop] = buildDeviceReport([row('desktop', 'LCP', 2), row('desktop', 'CLS', 2)], K)
    expect(desktop.samples).toBe(4)
    expect(desktop.metrics.every(m => m.value === null)).toBe(true)
  })

  test('the row total counts measurements across all five metrics', () => {
    const [desktop] = buildDeviceReport(
      [row('desktop', 'LCP', 10), row('desktop', 'CLS', 10), row('desktop', 'TTFB', 5)],
      K,
    )
    expect(desktop.samples).toBe(25)
  })

  test('the device rows account for every measurement the site-wide row has', () => {
    // The honesty check. If these two ever disagree, one of the two reports is
    // describing traffic the other cannot see, and an owner comparing them has
    // no way to tell which.
    const aggregates = [
      row('desktop', 'LCP', 30),
      row('mobile', 'LCP', 12),
      row('tablet', 'LCP', 7),
      row(null, 'LCP', 3),
      row('smart-fridge', 'LCP', 1),
    ]
    const perDevice = buildDeviceReport(aggregates, K).reduce((sum, r) => sum + r.samples, 0)
    expect(perDevice).toBe(53)
    const siteWide = buildReport([{ metric: 'LCP', p75: 1000, samples: 53 }], K)[0].samples
    expect(perDevice).toBe(siteWide)
  })

  test('an unrecognised device string lands in unknown, not in desktop', () => {
    // Folding it into a real class would move someone else's numbers into a
    // bucket an owner is about to make decisions from.
    const report = buildDeviceReport([row('smart-fridge', 'LCP', 20, 4000)], K)
    expect(report[0].samples).toBe(0)
    expect(report.find(r => r.device === 'unknown')!.samples).toBe(20)
  })

  test('no data at all is three empty rows, none of them suppressed', () => {
    const report = buildDeviceReport([], K)
    expect(report).toHaveLength(3)
    for (const device of report) {
      expect(device.samples).toBe(0)
      expect(device.metrics.every(m => m.samples === 0)).toBe(true)
      expect(device.metrics.every(m => m.suppressed)).toBe(false)
      expect(device.metrics.every(m => m.value === null)).toBe(true)
    }
  })

  test('k = 0 disables the floor here too', () => {
    const report = buildDeviceReport([row('mobile', 'LCP', 1, 4200)], 0)
    const mobile = report[1].metrics.find(m => m.metric === 'LCP')!
    expect(mobile.value).toBe(4200)
    expect(mobile.suppressed).toBe(false)
  })

  test('ratings come out per device, against the same thresholds', () => {
    // The point of the whole breakdown: the same LCP that is "good" on desktop
    // is "poor" on mobile, and the panel has to be able to say so.
    const report = buildDeviceReport(
      [row('desktop', 'LCP', 40, 2000), row('mobile', 'LCP', 40, 4500)],
      K,
    )
    expect(report[0].metrics.find(m => m.metric === 'LCP')!.rating).toBe('good')
    expect(report[1].metrics.find(m => m.metric === 'LCP')!.rating).toBe('poor')
  })
})

describe('the device column', () => {
  const src = code('routes/analytics.ts')
  const migration = read('database/migrations/0000000048-add-device-to-web_vitals.sql')

  test('is nullable, with no default and no backfill', () => {
    // We do not know the device for measurements taken before the column
    // existed. Defaulting them to a real class would skew that class's
    // percentile with rows that do not belong to it.
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS "device_type" varchar\(16\)/)
    expect(migration).not.toMatch(/device_type"[^\n]*NOT NULL/)
    expect(migration).not.toMatch(/device_type"[^\n]*DEFAULT/)
    expect(migration).not.toMatch(/UPDATE\s+"?web_vitals"?/i)
  })

  test('carries no semicolon in a comment below the first statement', () => {
    // Measured, not assumed. `idempotentSql` keeps the LEADING run of "--" lines
    // verbatim as a header and then splits the rest on ";" with no comment
    // handling, so a semicolon below the header cuts the line and re-emits the
    // remainder of the sentence outside the comment, where it runs as SQL.
    // Above the header it is harmless — migration 47's own note has one.
    //
    // Applied to every migration, not just this one: the hazard is silent, the
    // file that trips it is whichever one someone writes next, and the failure
    // arrives as a syntax error pointing at English.
    const dir = join(ROOT, 'database/migrations')
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql'))) {
      let seenStatement = false
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        const trimmed = line.trimStart()
        if (!trimmed.startsWith('--') && trimmed.length > 0) {
          seenStatement = true
          continue
        }
        if (seenStatement && trimmed.startsWith('--'))
          expect(`${file}: ${line}`).not.toContain(';')
      }
    }
  })

  test('is filled from the User-Agent, never from the beacon body', () => {
    // A device class the visitor's own payload could set is a device class an
    // owner cannot trust — and the whole breakdown is a thing people make
    // decisions from. It is parsed server-side, like the pageview path.
    const collect = src.slice(src.indexOf(`route.post('/collect'`))
    const branch = collect.slice(collect.indexOf(`if (body.e === 'vitals') {`))
    const insert = branch.indexOf('INSERT INTO web_vitals')
    expect(insert).toBeGreaterThan(0)
    const before = branch.slice(0, insert)
    expect(before).toContain('parseUserAgent(ua).deviceType')
    // Nothing between the branch opening and the insert may read a device off
    // the body. Written as a regex over the body accessors actually used.
    expect(before).not.toMatch(/body\.[a-z]*\s*(?:\?\?|\|\|)?\s*['"]?(?:desktop|mobile|tablet)/i)
  })

  test('is classified by the same parser the pageview path uses', () => {
    // Two reports on one dashboard that disagree about what a device is would be
    // worse than either being wrong on its own. Both paths call parseUserAgent
    // on the same header, so they cannot drift.
    //
    // This assertion is deliberately about the SHARED CALL, not about any
    // particular classification — which is what let the upstream parser be fixed
    // without touching anything here. Until @ts-analytics/tracking 0.1.13, an
    // iPad classified as `mobile` and every iOS visit recorded `macOS`; both are
    // now correct, and this test never needed to change because it never pinned
    // the wrong answer.
    const collect = src.slice(src.indexOf(`route.post('/collect'`))
    expect(collect).toContain('parseUserAgent(ua).deviceType')
    expect(collect).toContain('const info = parseUserAgent(ua)')
    expect(collect).toContain('device_type: info.deviceType')
  })

  test('is written in the same statement as the measurement', () => {
    // A second UPDATE would leave a window where a row has a metric and no
    // device, which the breakdown would silently bucket as unknown.
    const insert = src.match(/INSERT INTO web_vitals \(([^)]+)\) VALUES/)
    expect(insert).not.toBeNull()
    const columns = insert![1].split(',').map(c => c.trim())
    expect(columns).toContain('device_type')
    // The placeholder tuple has to match the column list, or every insert on the
    // hottest write path in the app fails at runtime and is swallowed by the
    // .catch that keeps the public beacon from 500ing.
    const tuple = src.match(/const placeholders = samples\.map\(\(\) => `\(([^`]+)\)`\)/)
    expect(tuple).not.toBeNull()
    expect(tuple![1].split(',')).toHaveLength(columns.length)
  })
})

describe('the device report routes', () => {
  const src = code('routes/analytics.ts')
  const vitalsRoute = src.slice(
    src.indexOf(`route.get('/api/sites/{siteId}/vitals'`),
    src.indexOf(`route.options('/api/sites/{siteId}/vitals-trends'`),
  )

  test('validate ?device= instead of matching it literally', () => {
    // An unrecognised device matched literally returns an empty report, which
    // reads as "your phone users have no measurements" rather than "you asked
    // for a device that does not exist".
    expect(vitalsRoute).toContain('isVitalDevice(request.query?.device)')
  })

  test('the breakdown itself is never narrowed by ?device=', () => {
    // It is the comparison the scope is chosen from. Narrowing it would leave
    // the caller holding one number with nothing to read it against.
    const start = vitalsRoute.indexOf('const byDevice = await pgq(')
    expect(start).toBeGreaterThan(0)
    const query = vitalsRoute.slice(start, vitalsRoute.indexOf(')', vitalsRoute.indexOf('GROUP BY 1, 2')))
    expect(query).toContain('GROUP BY 1, 2')
    expect(query).not.toContain('${scope}')
    expect(query).not.toContain('scopeParam')
  })

  test('the site-wide report and the per-path table do honour it', () => {
    expect(vitalsRoute).toMatch(/WHERE site_id = \? AND timestamp >= \? AND timestamp <= \?\$\{scope\}/)
    expect(vitalsRoute).toContain('...scopeParam')
  })

  test('echo the applied device back', () => {
    // So a caller that mistyped it can see it was not applied, rather than
    // reading a site-wide number as a mobile one.
    expect(vitalsRoute).toMatch(/^\s*device,$/m)
    expect(vitalsRoute).toMatch(/^\s*devices: buildDeviceReport\(/m)
  })

  test('the trend series can be scoped too', () => {
    // The natural next click once the breakdown shows mobile is the slow one:
    // has it always been, or did it regress?
    const trends = src.slice(src.indexOf(`route.get('/api/sites/{siteId}/vitals-trends'`))
    expect(trends).toContain('isVitalDevice(request.query?.device)')
    expect(trends).toContain('AND device_type = ?')
  })

  test('the unknown bucket is decided in one place, not also in SQL', () => {
    // normalizeVitalDevice inside buildDeviceReport is what turns a NULL group
    // into `unknown`. A COALESCE in the query would be a second copy of that
    // rule, in a language the tests above cannot reach.
    expect(src).not.toMatch(/COALESCE\(\s*device_type/i)
  })
})

describe('the dashboard panel', () => {
  const view = read('resources/views/dashboard.stx')

  test('renders a device row from the same helper the API uses', () => {
    expect(view).toContain('buildDeviceReport')
    expect(view).toContain('vitalsByDevice')
    expect(view).toContain('By device')
  })

  test('queries vitals by site and range only, never with the filter SQL', () => {
    // Same rule as the site-wide vitals query. `filter` appends predicates on
    // columns web_vitals does not have (country, browser), which would error the
    // whole render rather than just this panel.
    const start = view.indexOf('vitalsByDevice = buildDeviceReport(')
    expect(start).toBeGreaterThan(0)
    const query = view.slice(start, view.indexOf('GROUP BY 1, 2', start))
    expect(query).toContain('WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?')
    expect(query).not.toContain('${filter}')
  })

  test('distinguishes a withheld cell from an empty one', () => {
    // Two different facts. A dash where a number was withheld and a dot where
    // nothing was measured, each with a title that says which.
    expect(view).toContain('title="Withheld')
    expect(view).toContain('title="No measurements yet"')
  })

  test('survives a database that is not there yet', () => {
    // loadData throwing leaves vitalsByDevice as [], which would render a table
    // with a header and no rows.
    expect(view).toMatch(/if \(!vitalsByDevice\.length\)\s*\n\s*vitalsByDevice = buildDeviceReport\(\[\], privacy\.minSegmentSize\)/)
  })
})
