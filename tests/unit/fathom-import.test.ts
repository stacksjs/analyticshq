/**
 * Fathom import — reading a dashboard export, and the arithmetic that follows.
 *
 * The whole promise of this importer is that the numbers a customer sees after
 * importing are the numbers Fathom showed them. Nothing about that is checkable
 * by looking at a dashboard: an importer that reproduces 3 of 4 pageviews, or
 * three times the real visitor count, renders a chart that looks entirely
 * plausible. So the totals are pinned here, arithmetically, against the shapes
 * that actually break them.
 *
 * The fixture is the real thing — an untouched Fathom dashboard export, checked
 * in at tests/fixtures/fathom-export. It is deliberately small AND deliberately
 * degenerate: one page, and visitors equal to pageviews. Both of the bugs these
 * tests exist for are invisible against it, which is exactly why the synthetic
 * multi-page cases below are here as well.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  allocate,
  daysBetween,
  dealEvenly,
  FATHOM_PAGE_VIEW_PREFIX,
  FATHOM_SESSION_PREFIX,
  normFathomDevice,
  normFathomSource,
  parseBreakdown,
  parseRange,
  parseSummaryTotals,
  reconcileVisitors,
  spreadIndex,
  toRecords,
  type FathomExport,
} from '../../app/Analytics/fathom-import'
import { GA_PAGE_VIEW_PREFIX, GA_SESSION_PREFIX, synthesizeRecord } from '../../app/Analytics/ga-import'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const fixture = (name: string) => read(join('tests/fixtures/fathom-export', name))

/** A minimal export whose breakdowns all sum to `people`, as Fathom's do. */
function exportOf(people: number, pages: Array<[string, number, number]>): FathomExport {
  return {
    from: '2026-09-02',
    to: '2026-09-08',
    people,
    pageviews: pages.reduce((n, p) => n + p[2], 0),
    pages: new Map(pages.map(([path, visitors, pageviews]) => [path, { visitors, pageviews }])),
    countries: new Map([['United States', people]]),
    devices: new Map([['Desktop', people]]),
    browsers: new Map([['Chrome', people]]),
    systems: new Map([['Windows', people]]),
    sources: new Map([['Direct', people]]),
  }
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)

describe('reading the export', () => {
  test('the date range comes from the one cell that carries it', () => {
    expect(parseRange(fixture('Summary.csv'))).toEqual({ from: '2026-09-02', to: '2026-09-08' })
  })

  test('a summary with no range at all is null, not a guess', () => {
    expect(parseRange('Metric,Value\nPeople,5\n')).toBeNull()
  })

  test('the site totals are read by row label, not by position', () => {
    expect(parseSummaryTotals(fixture('Summary.csv'))).toEqual({ people: 5, pageviews: 5 })
  })

  test('a summary missing a row degrades to zero rather than throwing', () => {
    expect(parseSummaryTotals('Metric,Value\nPageviews,12\n')).toEqual({ people: 0, pageviews: 12 })
    expect(parseSummaryTotals('')).toEqual({ people: 0, pageviews: 0 })
  })

  test('breakdowns parse to the counts Fathom shows', () => {
    expect([...parseBreakdown(fixture('Browsers.csv'))]).toEqual([['Chrome', 3], ['Safari', 2]])
    expect([...parseBreakdown(fixture('Device_Types.csv'))]).toEqual([['Desktop', 3], ['Phone', 2]])
    expect([...parseBreakdown(fixture('Operating_Systems.csv'))]).toEqual([['Windows', 2], ['iOS', 2], ['OS X', 1]])
    expect([...parseBreakdown(fixture('Countries.csv'))]).toEqual([['United States', 5]])
    expect([...parseBreakdown(fixture('Sources.csv'))]).toEqual([['Direct', 5]])
  })

  test('every breakdown sums to Summary.People, which is what makes it the denominator', () => {
    const { people } = parseSummaryTotals(fixture('Summary.csv'))
    for (const name of ['Browsers.csv', 'Device_Types.csv', 'Operating_Systems.csv', 'Countries.csv', 'Sources.csv'])
      expect(sum([...parseBreakdown(fixture(name)).values()])).toBe(people)
  })

  test('a header-only file is empty, not an error - Fathom ships those', () => {
    expect(parseBreakdown(fixture('UTM_Source.csv')).size).toBe(0)
    expect(parseBreakdown(fixture('Events.csv')).size).toBe(0)
  })

  test("Fathom's vocabulary is mapped to ours, and its own docs are wrong about it", () => {
    expect(normFathomDevice('Phone')).toBe('mobile')
    expect(normFathomDevice('Desktop')).toBe('desktop')
    expect(normFathomSource('Direct')).toBe('Direct')
    expect(normFathomSource('Direct / Unknown')).toBe('Direct')
  })
})

describe('allocation', () => {
  test('a breakdown is dealt out to exactly the total asked for', () => {
    const b = new Map([['Chrome', 3], ['Safari', 2]])
    for (const total of [1, 2, 5, 7, 100, 1001])
      expect(allocate(b, total)).toHaveLength(total)
  })

  test('largest-remainder keeps the proportions without losing a unit', () => {
    const dealt = allocate(new Map([['a', 2], ['b', 1]]), 10)
    expect(dealt.filter(x => x === 'a')).toHaveLength(7)
    expect(dealt.filter(x => x === 'b')).toHaveLength(3)
  })

  test('dealEvenly sums to the total for every split, which round() did not', () => {
    for (const total of [0, 1, 4, 5, 7, 11, 137])
      for (const slots of [1, 2, 3, 8])
        expect(sum(dealEvenly(total, slots))).toBe(total)
  })

  test('dealEvenly is the exact case the old per-visitor round() got wrong', () => {
    // 3 visitors over 4 views used to round to 1 each and reproduce 3 of 4;
    // 2 visitors over 5 used to round to 3 each and reproduce 6 of 5.
    expect(dealEvenly(4, 3)).toEqual([2, 1, 1])
    expect(dealEvenly(5, 2)).toEqual([3, 2])
  })

  test('no slots means no split, not a divide by zero', () => {
    expect(dealEvenly(9, 0)).toEqual([])
  })
})

describe('spreading across days', () => {
  test('the range is inclusive of both ends', () => {
    expect(daysBetween('2026-09-02', '2026-09-08')).toHaveLength(7)
    expect(daysBetween('2026-09-02', '2026-09-02')).toEqual(['2026-09-02'])
  })

  test('visitors span the whole range rather than packing into the front', () => {
    const days = daysBetween('2026-09-02', '2026-09-08').length
    const landed = Array.from({ length: 5 }, (_, i) => spreadIndex(i, 5, days))
    expect(landed[0]).toBe(0)
    expect(landed[landed.length - 1]).toBe(days - 1)
  })
})

describe('reconciling visitors against real people', () => {
  test('pages that already agree with the summary are left alone', () => {
    const r = reconcileVisitors(new Map([['/', { visitors: 5, pageviews: 5 }]]), 5)
    expect(r.total).toBe(5)
    expect(r.counts.get('/')).toBe(5)
  })

  test('a multi-page site is scaled back to the deduplicated people count', () => {
    const pages = new Map([
      ['/', { visitors: 100, pageviews: 140 }],
      ['/about', { visitors: 40, pageviews: 45 }],
      ['/blog', { visitors: 25, pageviews: 30 }],
    ])
    const r = reconcileVisitors(pages, 120)
    expect(r.rawTotal).toBe(165)
    expect(r.total).toBe(120)
    expect(sum([...r.counts.values()])).toBe(120)
  })

  test('a page Fathom shows never scales away to nothing', () => {
    const pages = new Map([
      ['/popular', { visitors: 9990, pageviews: 9990 }],
      ['/obscure', { visitors: 1, pageviews: 1 }],
    ])
    expect(reconcileVisitors(pages, 100).counts.get('/obscure')).toBeGreaterThanOrEqual(1)
  })

  test('more pages than people keeps every page and reports the overshoot', () => {
    const pages = new Map([
      ['/a', { visitors: 1, pageviews: 1 }],
      ['/b', { visitors: 1, pageviews: 1 }],
      ['/c', { visitors: 1, pageviews: 1 }],
    ])
    const r = reconcileVisitors(pages, 2)
    expect(r.total).toBe(3)
    expect(r.total).toBeGreaterThan(2)
  })

  test('a silent summary is not a licence to invent a denominator', () => {
    const pages = new Map([['/', { visitors: 3, pageviews: 7 }]])
    expect(reconcileVisitors(pages, 0).total).toBe(3)
  })

  test('pages summing to less than people are never inflated to reach it', () => {
    const pages = new Map([['/', { visitors: 2, pageviews: 2 }]])
    const r = reconcileVisitors(pages, 50)
    expect(r.total).toBe(2)
  })
})

describe('records reproduce the export', () => {
  test('the real export comes back as the numbers Fathom printed', () => {
    const exp: FathomExport = {
      ...parseRange(fixture('Summary.csv'))!,
      ...parseSummaryTotals(fixture('Summary.csv')),
      pages: new Map([['/', { visitors: 5, pageviews: 5 }]]),
      countries: parseBreakdown(fixture('Countries.csv')),
      devices: parseBreakdown(fixture('Device_Types.csv')),
      browsers: parseBreakdown(fixture('Browsers.csv')),
      systems: parseBreakdown(fixture('Operating_Systems.csv')),
      sources: parseBreakdown(fixture('Sources.csv')),
    }
    const recs = toRecords(exp)
    expect(sum(recs.map(r => r.users))).toBe(5)
    expect(sum(recs.map(r => r.pageviews))).toBe(5)

    const count = (key: 'device' | 'browser' | 'os' | 'country') =>
      recs.reduce<Record<string, number>>((acc, r) => {
        acc[String(r[key])] = (acc[String(r[key])] || 0) + r.users
        return acc
      }, {})
    expect(count('device')).toEqual({ desktop: 3, mobile: 2 })
    expect(count('browser')).toEqual({ Chrome: 3, Safari: 2 })
    expect(count('os')).toEqual({ Windows: 2, iOS: 2, macOS: 1 })
    expect(count('country')).toEqual({ US: 5 })
  })

  test('pageview totals survive splits that do not divide evenly', () => {
    for (const [people, pages] of [
      [3, [['/', 3, 4]]],
      [2, [['/', 2, 5]]],
      [9, [['/a', 7, 11], ['/b', 3, 4], ['/c', 1, 1], ['/d', 1, 2]]],
      [120, [['/', 100, 140], ['/about', 40, 45], ['/blog', 25, 30]]],
    ] as Array<[number, Array<[string, number, number]>]>) {
      const recs = toRecords(exportOf(people, pages))
      expect(sum(recs.map(r => r.pageviews))).toBe(sum(pages.map(p => p[2])))
      expect(sum(recs.map(r => r.users))).toBe(people)
    }
  })

  test('the country marginal stays denominated in people, not in page rows', () => {
    const exp = exportOf(120, [['/', 100, 140], ['/about', 40, 45], ['/blog', 25, 30]])
    exp.countries = new Map([['United States', 90], ['Canada', 30]])
    const recs = toRecords(exp)
    const byCountry = recs.reduce<Record<string, number>>((acc, r) => {
      acc[String(r.country)] = (acc[String(r.country)] || 0) + r.users
      return acc
    }, {})
    expect(byCountry).toEqual({ US: 90, CA: 30 })
  })

  test('the marginals stay exact however many pages the site has', () => {
    // The per-page allocation this replaced was off by one per page, always in
    // the same direction, so the error grew with the page count instead of
    // cancelling. Sweeping the page count is the only way that shows up.
    for (const pageCount of [1, 2, 3, 7, 20, 97]) {
      const pages: Array<[string, number, number]> = Array.from(
        { length: pageCount },
        (_, i) => [`/p${i}`, 40 + i * 3, 55 + i * 4],
      )
      // Below the page total, as a real multi-page export always is: that is
      // the case reconciliation exists for and the one the marginals ride on.
      const people = Math.floor(sum(pages.map(p => p[1])) * 0.7)
      const ca = Math.floor(people * 0.25)
      const jp = Math.floor(people * 0.11)
      const us = people - ca - jp

      const exp = exportOf(people, pages)
      exp.countries = new Map([['United States', us], ['Canada', ca], ['Japan', jp]])
      exp.browsers = new Map([['Chrome', us], ['Safari', ca], ['Firefox', jp]])
      const recs = toRecords(exp)

      const by = (key: 'country' | 'browser') => recs.reduce<Record<string, number>>((acc, r) => {
        acc[String(r[key])] = (acc[String(r[key])] || 0) + r.users
        return acc
      }, {})
      expect(by('country')).toEqual({ US: us, CA: ca, JP: jp })
      expect(by('browser')).toEqual({ Chrome: us, Safari: ca, Firefox: jp })
      expect(sum(recs.map(r => r.users))).toBe(people)
      expect(sum(recs.map(r => r.pageviews))).toBe(sum(pages.map(p => p[2])))
    }
  })

  test('no page is handed a single country because the labels arrive grouped', () => {
    // allocate() returns its labels in blocks. Slicing that array per page would
    // give the first page every US visitor and the last page every Canadian one,
    // inventing a page/country correlation the export does not contain.
    const pages: Array<[string, number, number]> = Array.from(
      { length: 4 },
      (_, i) => [`/p${i}`, 50, 50],
    )
    const exp = exportOf(200, pages)
    exp.countries = new Map([['United States', 100], ['Canada', 100]])
    const recs = toRecords(exp)
    for (const path of ['/p0', '/p1', '/p2', '/p3']) {
      const seen = new Set(recs.filter(r => r.path === path).map(r => r.country))
      expect([...seen].sort()).toEqual(['CA', 'US'])
    }
  })

  test('every visitor gets at least one pageview', () => {
    // An export whose Pages row claims more people than views is malformed, and
    // a visitor with nothing to look at is not a row the dashboard can render.
    for (const r of toRecords(exportOf(4, [['/', 4, 2]])))
      expect(r.pageviews).toBeGreaterThanOrEqual(r.users)
  })

  test('records are stable across runs, so a re-import is a no-op not a double', () => {
    const a = toRecords(exportOf(9, [['/a', 7, 11], ['/b', 3, 4]]))
    const b = toRecords(exportOf(9, [['/a', 7, 11], ['/b', 3, 4]]))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  test('an empty export produces no rows rather than a phantom day', () => {
    expect(toRecords(exportOf(0, []))).toEqual([])
  })
})

describe('isolation from the GA importer', () => {
  test('the two importers cannot delete each other rows', () => {
    expect(FATHOM_PAGE_VIEW_PREFIX).not.toBe(GA_PAGE_VIEW_PREFIX)
    expect(FATHOM_SESSION_PREFIX).not.toBe(GA_SESSION_PREFIX)
    for (const p of [FATHOM_PAGE_VIEW_PREFIX, FATHOM_SESSION_PREFIX])
      for (const g of [GA_PAGE_VIEW_PREFIX, GA_SESSION_PREFIX])
        expect(p.startsWith(g)).toBe(false)
  })

  test('synthesis writes the Fathom prefixes when asked for them', () => {
    const rec = toRecords(exportOf(2, [['/', 2, 3]]))[0]
    const rows = synthesizeRecord('site_1', rec, new Date('2026-09-02T00:00:00Z'), {
      pageView: FATHOM_PAGE_VIEW_PREFIX,
      session: FATHOM_SESSION_PREFIX,
    })
    expect(rows.pageViews.length).toBeGreaterThan(0)
    for (const row of rows.pageViews)
      expect(String(row.id).startsWith(FATHOM_PAGE_VIEW_PREFIX)).toBe(true)
    for (const row of rows.sessions)
      expect(String(row.id).startsWith(FATHOM_SESSION_PREFIX)).toBe(true)
  })

  test('the same export synthesizes the same ids twice', () => {
    const rec = toRecords(exportOf(2, [['/', 2, 3]]))[0]
    const at = new Date('2026-09-02T00:00:00Z')
    const prefixes = { pageView: FATHOM_PAGE_VIEW_PREFIX, session: FATHOM_SESSION_PREFIX }
    const a = synthesizeRecord('site_1', rec, at, prefixes)
    const b = synthesizeRecord('site_1', rec, at, prefixes)
    expect(a.pageViews.map(r => r.id)).toEqual(b.pageViews.map(r => r.id))
  })
})

describe('what the export cannot say', () => {
  test('city and region are never read, because the schema dropped them', () => {
    // Migration 0000000011 dropped page_views.city/region: country-only
    // geolocation is an invariant (#7). Fathom exports both; we leave them.
    const src = read('app/Analytics/fathom-import.ts')
    expect(src).not.toContain('Cities.csv')
    expect(src).not.toContain('Regions.csv')
    const cli = read('scripts/analytics/import-fathom.ts')
    expect(cli).not.toContain('Cities.csv')
    expect(cli).not.toContain('Regions.csv')
  })

  test('the joint distribution is documented as absent, not quietly claimed', () => {
    expect(read('app/Analytics/fathom-import.ts')).toContain('not cross-tabulated')
  })
})
