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
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  allocate,
  daysBetween,
  dealEvenly,
  estimateRows,
  FATHOM_PAGE_VIEW_PREFIX,
  FATHOM_SESSION_PREFIX,
  fathomBasename,
  fathomImportWarnings,
  normFathomDevice,
  normFathomSource,
  parseBreakdown,
  parseFiltersApplied,
  parseRange,
  parseSummaryTotals,
  readFathomExport,
  reconcileVisitors,
  spreadIndex,
  toRecords,
  type FathomExport,
  type FathomImportNotes,
} from '../../app/Analytics/fathom-import'
import { GA_PAGE_VIEW_PREFIX, GA_SESSION_PREFIX, synthesizeRecord } from '../../app/Analytics/ga-import'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const fixture = (name: string) => read(join('tests/fixtures/fathom-export', name))
/** Source with comments stripped, so a guard cannot be satisfied by prose. */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

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

describe('assembling an upload', () => {
  /** The 18 real CSVs, keyed the way a folder picker reports them. */
  const uploaded = (prefix = '') => new Map(
    readdirSync(join(ROOT, 'tests/fixtures/fathom-export'))
      .filter(n => n.endsWith('.csv'))
      .map(n => [`${prefix}${n}`, fixture(n)]),
  )

  test('the real export reads back the numbers Fathom printed', () => {
    const read = readFathomExport(uploaded())
    expect('error' in read).toBe(false)
    if ('error' in read)
      return
    expect(read.export.from).toBe('2026-09-02')
    expect(read.export.to).toBe('2026-09-08')
    expect(read.export.people).toBe(5)
    expect(read.export.pageviews).toBe(5)
    expect(read.export.pages.get('/')).toEqual({ visitors: 5, pageviews: 5 })
  })

  test('a leading folder on every key changes nothing', () => {
    // A folder picker reports "Dashboard_Export_2026-09-08/Pages.csv"; a zip
    // listing can be worse. Only the basename is ever matched.
    const flat = readFathomExport(uploaded())
    const nested = readFathomExport(uploaded('dummy_Dashboard_Export_2026-09-08/'))
    expect('error' in nested).toBe(false)
    if ('error' in flat || 'error' in nested)
      return
    expect(nested.export.people).toBe(flat.export.people)
    expect([...nested.export.pages]).toEqual([...flat.export.pages])
  })

  test('files we do not read are noted, never treated as an error', () => {
    const read = readFathomExport(uploaded())
    if ('error' in read)
      throw new Error(read.error)
    expect(read.notes.missing).toEqual([])
    expect(read.notes.ignored).toContain('Referrers.csv')
    expect(read.notes.ignored).toContain('UTM_Term.csv')
  })

  test('a filename Fathom adds later is ignored rather than fatal', () => {
    // Entry_Pages.csv and Exit_Pages.csv arrived in the March 2026 rebuild with
    // no schema version to notice them by, so an unknown name cannot be a refusal.
    const files = uploaded()
    files.set('Something_New.csv', 'Header,Visitors\nx,1\n')
    expect('error' in readFathomExport(files)).toBe(false)
  })

  test('every refusal is a sentence, and nothing throws', () => {
    const cases: Array<[string, Map<string, string>, string]> = [
      ['nothing at all', new Map(), 'Summary.csv was not in the upload'],
      ['no Summary.csv', new Map([['Pages.csv', fixture('Pages.csv')]]), 'Summary.csv was not in the upload'],
      ['a Summary with no range', new Map([['Summary.csv', 'Metric,Value\nPeople,5\n']]), 'Could not read the date range'],
      ['no Pages.csv', new Map([['Summary.csv', fixture('Summary.csv')]]), 'Pages.csv was not in the upload'],
      ['a header-only Pages.csv', new Map([
        ['Summary.csv', fixture('Summary.csv')],
        ['Pages.csv', 'Page,Visitors,Pageviews\n'],
      ]), 'Pages.csv has no data rows'],
    ]
    for (const [label, files, expected] of cases) {
      const read = readFathomExport(files)
      expect(`${label}: ${'error' in read}`).toBe(`${label}: true`)
      if ('error' in read)
        expect(read.error).toContain(expected)
    }
  })

  test('only the basename of a path is ever matched', () => {
    expect(fathomBasename('Export/Pages.csv')).toBe('Pages.csv')
    expect(fathomBasename('Export\\Pages.csv')).toBe('Pages.csv')
    expect(fathomBasename('Pages.csv')).toBe('Pages.csv')
    expect(fathomBasename('../../etc/passwd')).toBe('passwd')
    expect(fathomBasename('')).toBe('')
  })

  test('a filtered export is detected, because it looks exactly like a whole one', () => {
    expect(parseFiltersApplied(fixture('Summary.csv'))).toBe(0)
    expect(parseFiltersApplied('Metric,Value\n"Filters Applied",2\n')).toBe(2)
    expect(parseFiltersApplied('Metric,Value\nPeople,5\n')).toBe(0)
    const files = new Map([
      ['Summary.csv', fixture('Summary.csv').replace('"Filters Applied",0', '"Filters Applied",3')],
      ['Pages.csv', fixture('Pages.csv')],
    ])
    const read = readFathomExport(files)
    if ('error' in read)
      throw new Error(read.error)
    expect(read.notes.filtersApplied).toBe(3)
  })

  test('the estimate matches what the import actually writes', () => {
    // The 413 refusal is computed from this, so an estimate that disagreed with
    // the write would refuse imports that fit and admit ones that do not.
    for (const [people, pages] of [
      [5, [['/', 5, 5]]],
      [3, [['/', 3, 4]]],
      [120, [['/', 100, 140], ['/about', 40, 45], ['/blog', 25, 30]]],
      [9, [['/a', 7, 11], ['/b', 3, 4], ['/c', 1, 1], ['/d', 1, 2]]],
    ] as Array<[number, Array<[string, number, number]>]>) {
      const exp = exportOf(people, pages)
      const recs = toRecords(exp)
      expect(estimateRows(exp)).toEqual({
        pageViews: sum(recs.map(r => r.pageviews)),
        sessions: sum(recs.map(r => r.users)),
      })
    }
  })
})

describe('warnings name what the numbers hide', () => {
  const notes = (over: Partial<FathomImportNotes> = {}): FathomImportNotes => ({
    missing: [],
    ignored: [],
    filtersApplied: 0,
    people: 100,
    rawVisitors: 100,
    reconciledVisitors: 100,
    ...over,
  })

  test('a clean import says nothing rather than reassuring', () => {
    expect(fathomImportWarnings(notes())).toEqual([])
  })

  test('the scaled-down warning quotes both numbers', () => {
    const [w] = fathomImportWarnings(notes({ people: 1204, rawVisitors: 3880, reconciledVisitors: 1204 }))
    expect(w).toContain('1,204')
    expect(w).toContain('3,880')
  })

  test('visitors are never described as reading higher, because they do not', () => {
    // reconcileVisitors scales the page column DOWN to Summary.People. Copy
    // claiming imported visitors read higher than Fathom would be a lie, and it
    // is the mistake this feature was designed around three separate times.
    const every = [
      notes({ people: 1204, rawVisitors: 3880, reconciledVisitors: 1204 }),
      notes({ people: 500, rawVisitors: 640, reconciledVisitors: 640 }),
      notes({ missing: ['Countries.csv'], ignored: ['Referrers.csv'], filtersApplied: 1 }),
    ].flatMap(fathomImportWarnings).join(' ')
    expect(every).not.toContain('higher')
  })

  test('more pages than people is its own sentence', () => {
    const out = fathomImportWarnings(notes({ people: 500, rawVisitors: 640, reconciledVisitors: 640 }))
    expect(out.some(w => w.includes('more pages than people'))).toBe(true)
  })

  test('missing and unread files each get named', () => {
    const out = fathomImportWarnings(notes({ missing: ['Countries.csv', 'Sources.csv'], ignored: ['Referrers.csv'] }))
    expect(out.some(w => w.includes('Countries.csv, Sources.csv'))).toBe(true)
    expect(out.some(w => w.includes('not imported yet'))).toBe(true)
  })

  test('a filtered export is called a subset', () => {
    expect(fathomImportWarnings(notes({ filtersApplied: 2 })).some(w => w.includes('subset'))).toBe(true)
  })
})

describe('the upload endpoint', () => {
  const routes = code('routes/analytics.ts')
  const decl = "route.post('/api/sites/{siteId}/import/fathom'"
  // Bounded by the next registration rather than by a character count: every
  // assertion below is an indexOf into this slice, and a handler that outgrew a
  // fixed window would not fail them, it would silently start comparing -1s.
  const block = routes.slice(routes.indexOf(decl), routes.indexOf('\nroute.', routes.indexOf(decl) + 1))

  test('the route exists at column 0, where the authorization sweep can see it', () => {
    // api-authz.test.ts collects site-scoped routes with a `^`-anchored regex, so
    // an indented registration does not fail that sweep, it escapes it.
    expect(routes).toContain(`\n${decl}`)
    expect(routes).toContain("route.options('/api/sites/{siteId}/import/fathom'")
  })

  test('ownership is checked before billing, so an outsider learns nothing', () => {
    expect(block.slice(0, 400)).toContain('requireSiteOwner(request, siteId)')
    expect(block.indexOf('requireSiteOwner')).toBeLessThan(block.indexOf('requirePlanIncludes'))
    expect(block).toContain("requirePlanIncludes(\n    String(siteId),\n    'csvImport'")
  })

  test('the endpoint is authenticated and rate limited', () => {
    const chain = block.slice(block.indexOf('.middleware('), block.indexOf('.middleware(') + 80)
    expect(chain).toContain(".middleware('auth')")
    expect(chain).toContain('.skipCsrf()')
    expect(chain).toContain('.rateLimit(')
  })

  test('the size and row ceilings are checked before anything is written', () => {
    expect(block.indexOf('FATHOM_MAX_UPLOAD_BYTES')).toBeLessThan(block.indexOf('DELETE FROM page_views'))
    expect(block.indexOf('estimateRows(')).toBeLessThan(block.indexOf('DELETE FROM page_views'))
    expect(block.indexOf('FATHOM_MAX_ROWS_PER_REQUEST')).toBeLessThan(block.indexOf('buildInsert('))
  })

  test('replace deletes this importer rows and no other importer rows', () => {
    const replace = block.slice(block.indexOf('DELETE FROM page_views'), block.indexOf('const now = new Date()'))
    expect(replace).toContain('FATHOM_PAGE_VIEW_PREFIX')
    expect(replace).toContain('FATHOM_SESSION_PREFIX')
    expect(replace).not.toContain('GA_PAGE_VIEW_PREFIX')
    expect(replace).not.toContain('GA_SESSION_PREFIX')
  })

  test('sessions are inserted before page views, which hold the foreign key', () => {
    const flush = block.slice(block.indexOf('const flush ='), block.indexOf('for (const record of records)'))
    expect(flush.indexOf("buildInsert('sessions'")).toBeLessThan(flush.indexOf("buildInsert('page_views'"))
  })

  test('the uploaded CSV is never stored, logged or echoed back', () => {
    expect(block).not.toContain('INSERT INTO sites')
    expect(block).not.toContain('UPDATE sites')
    expect(block).not.toContain('console.log')
    expect(block).not.toMatch(/\bsettings\s*=/)
  })

  test('nothing in the new route widens the fingerprint surface', () => {
    // fingerprint-surface.test.ts fails on `title:` anywhere in this file, and
    // Fathom's Pages export does carry page titles.
    expect(block).not.toMatch(/\btitle:\s/)
  })

  test('no browser storage is named, in the code or in the comments', () => {
    // privacy-guardrails.test.ts reads routes/analytics.ts RAW, so a comment
    // saying "nothing is kept in localStorage" would turn the suite red.
    const rawBlock = read('routes/analytics.ts')
    const start = rawBlock.indexOf('// Fathom import (CSV upload)')
    const region = rawBlock.slice(start, rawBlock.indexOf('// Search Console (#25)', start))
    expect(region.length).toBeGreaterThan(1000)
    for (const token of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie'])
      expect(region).not.toContain(token)
  })

  test('the warnings the module produces are the ones the route returns', () => {
    expect(block).toContain('fathomImportWarnings(')
    expect(block).toContain('warnings,')
  })

  test('a zip is unzipped before either ceiling is applied, and both shapes converge', () => {
    // The two upload shapes have to become one pair of values before the reading
    // starts, or the ceilings, the Custom Export check and the windowing each
    // grow a second version that is free to disagree with the first.
    expect(block).toContain('readFathomZip(')
    expect(block.indexOf('readFathomZip(')).toBeLessThan(block.indexOf('readFathomExport('))
    expect(block.indexOf('readFathomZip(')).toBeLessThan(block.indexOf('estimateRows('))
    expect(block).toContain('files = unzipped.files')
    expect(block).toContain('names = unzipped.names')
  })

  test('the names a zip carried are passed on, so the skipped files are still named', () => {
    // readFathomZip inflates seven of the eighteen, so `files` alone cannot show
    // that Referrers.csv and the UTM files were in the upload.
    expect(block).toContain('readFathomExport(files, names)')
  })

  test('the zip is never stored or echoed back, only read', () => {
    expect(block).not.toMatch(/\bwriteFile|\bBun\.write|\bmkdir/)
    // The base64 goes straight into the reader and is not put in a response.
    expect(block).not.toMatch(/zip:\s*body\.zip/)
  })
})

describe('the dashboard panel', () => {
  const view = read('resources/views/dashboard.stx')
  const panel = view.slice(view.indexOf('{{-- Import from Fathom.'), view.indexOf('@if (shareMode)'))

  test('the panel is there and is a real region, not an empty slice', () => {
    expect(panel.length).toBeGreaterThan(2000)
    expect(panel).toContain('type="file"')
  })

  test('the file input is never bound with x-model, which cannot hold a file', () => {
    // stx's model binding has no file branch: it would hold the browser's fake
    // path string, and a programmatic write throws inside an effect that
    // re-throws and takes the writing caller with it.
    const input = panel.slice(panel.indexOf('<input id="fathom-files"'), panel.indexOf('</label>', panel.indexOf('<input id="fathom-files"')))
    expect(input).toContain('@change="pickFathomFiles"')
    expect(input).not.toContain('x-model')
    expect(input).toContain('class="sr-only"')
  })

  test('drag events use the @ form, which is the only one that binds', () => {
    // dragover/drop are absent from the runtime event list, so `:drop` is not an
    // event at all: it silently becomes a DOM attribute that never fires.
    expect(panel).toContain('@drop.prevent=')
    expect(panel).toContain('@dragover.prevent')
    expect(panel).not.toContain(':drop=')
    expect(panel).not.toContain(':dragover=')
  })

  test('everything that starts hidden says so statically as well', () => {
    // :show reads the inline display at bind time; without the static
    // counterpart the element flashes before hydration hides it.
    const lines = panel.split('\n').filter(l => l.includes(':show='))
    expect(lines.length).toBeGreaterThan(3)
    for (const line of lines)
      expect(`${line.trim().slice(0, 60)} -> ${line.includes('style="display:none"')}`).toContain('-> true')
  })

  test('both buttons keep static labels, so neither is cloaked before hydration', () => {
    for (const btn of panel.match(/<button[\s\S]*?<\/button>/g) ?? [])
      expect(btn).not.toContain('{{')
  })

  test('the panel promises nothing the importer does not do', () => {
    expect(panel).toContain('Fathom exports daily totals, not individual visits')
    expect(panel).toContain('not imported yet')
    expect(panel).not.toContain('—')
    expect(panel).not.toContain('–')
  })

  test('the zip is what the panel asks for, and nobody is told to unzip it', () => {
    expect(panel).toContain('.zip')
    expect(panel.toLowerCase()).not.toContain('unzip it')
    // Still accepts loose CSVs, for an export somebody already unpacked.
    expect(panel).toContain('.csv')
  })

  test('the zip is posted whole and never opened in the browser', () => {
    // A client block cannot import, so an unzipper here would be a hundred lines
    // of offsets that tsc cannot see inside and no test can reach.
    const script = view.slice(view.indexOf('// --- Fathom import'), view.indexOf('async function createShare'))
    expect(script).toContain('readAsDataURL')
    expect(script).toContain('{ zip: fathomZip() }')
    // Names, not the word "inflate": the comment above the panel explains why a
    // browser cannot open a zip, and a guard that forbade saying so would be a
    // guard against the explanation rather than against the code.
    for (const token of ['DecompressionStream', 'inflateRaw', 'JSZip', 'fflate', '0x06054B50'])
      expect(script).not.toContain(token)
  })

  test('the two upload shapes are exclusive, so a request cannot carry both', () => {
    const script = view.slice(view.indexOf('// --- Fathom import'), view.indexOf('async function createShare'))
    // Each setter clears the other, and the reset after an import clears both.
    expect(script).toContain('fathomFiles.set({})\n    fathomZip.set(encoded)')
    expect(script).toContain('fathomZip.set(\'\')\n  fathomFiles.set(picked)')
    expect(script).toContain('fathomFiles.set({})\n  fathomZip.set(\'\')')
  })

  test('the paywall is server-rendered, not a client conditional', () => {
    // A client @if nested inside a server @if breaks stx's @endif matching.
    expect(panel).toContain('@if (canImportCsv)')
    expect(panel).toContain('Upgrade to Pro')
    expect(panel).not.toContain(':if=')
  })
})

describe('splitting an export too big for one request', () => {
  /**
   * The real `fathomWindows`, lifted out of the view and run.
   *
   * It lives in the dashboard's client script because no client block in this
   * app imports anything, and moving it out to be testable would be the first
   * one to try. Reading the shipped source instead means this cannot drift from
   * what actually runs in the browser.
   */
  const fathomWindows: (from: string, to: string, days: number) => Array<[string, string]> = (() => {
    const view = read('resources/views/dashboard.stx')
    const start = view.indexOf('function fathomWindows(')
    expect(start).toBeGreaterThan(0)
    const body = view.slice(start, view.indexOf('\n}', start) + 2)
      .replace(/: Array<\[string, string\]>/g, '')
      .replace(/: string|: number/g, '')
    // eslint-disable-next-line no-new-func
    return new Function(`${body}; return fathomWindows`)() as any
  })()

  test('windows tile the range with no gap and no overlap', () => {
    for (const [from, to, size] of [
      ['2023-01-01', '2025-12-31', 104],
      ['2026-09-02', '2026-09-08', 3],
      ['2026-09-02', '2026-09-02', 7],
      ['2024-01-01', '2024-12-31', 1],
    ] as Array<[string, string, number]>) {
      const windows = fathomWindows(from, to, size)
      const days = daysBetween(from, to)
      const covered: string[] = []
      for (const [f, t] of windows)
        covered.push(...days.filter(d => d >= f && d <= t))
      expect(`${from}..${to}/${size}: ${covered.length}`).toBe(`${from}..${to}/${size}: ${days.length}`)
      expect(new Set(covered).size).toBe(days.length)
      expect(windows[0][0]).toBe(from)
      expect(windows[windows.length - 1][1]).toBe(to)
    }
  })

  test('no window is longer than asked for', () => {
    for (const [f, t] of fathomWindows('2023-01-01', '2025-12-31', 104))
      expect(daysBetween(f, t).length).toBeLessThanOrEqual(104)
  })

  test('a windowed import adds up to the whole one, record for record', () => {
    // This is what makes refusing an oversized export safe rather than a dead
    // end: the SAME file is posted again in windows, and because the synthesis
    // is deterministic the pieces are exactly the rows the whole file produces.
    const pages: Array<[string, number, number]> = Array.from(
      { length: 40 },
      (_, i) => [`/p${i}`, 300 + i, 700 + i * 3],
    )
    const exp = exportOf(9000, pages)
    exp.from = '2024-01-01'
    exp.to = '2024-12-31'
    const all = toRecords(exp)

    const seen = new Set<string>()
    let pageViews = 0
    for (const [f, t] of fathomWindows(exp.from, exp.to, 37)) {
      for (const r of all.filter(x => x.date >= f && x.date <= t)) {
        seen.add(`${r.date}|${r.path}|${r.source}|${r.country}|${r.device}|${r.browser}|${r.os}`)
        pageViews += r.pageviews
      }
    }
    expect(seen.size).toBe(all.length)
    expect(pageViews).toBe(sum(all.map(r => r.pageviews)))
    expect(pageViews).toBe(estimateRows(exp).pageViews)
  })
})
