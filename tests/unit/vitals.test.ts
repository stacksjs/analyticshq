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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildReport,
  formatVital,
  isVitalMetric,
  parseVitalsPayload,
  percentile,
  rating,
  RATING_COLOR,
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
    // web_vitals has no country/device/browser column, so a filter has nothing
    // to narrow. Returning unfiltered numbers under an active filter without
    // saying so is the worst of the available options.
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
