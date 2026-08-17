/**
 * Google Analytics import — the mapping, the synthesis, and the API client.
 *
 * There are two importers (a CSV a human exported, and the Data API) and they
 * must produce the same rows for the same property. Everything that decides what
 * a GA row becomes lives in app/Analytics/ga-import.ts for that reason, and this
 * is where those decisions are pinned.
 *
 * The network half runs against a fake Google in a separate probe; what is here
 * is the part that is pure, which is where the arithmetic errors live — an
 * importer that quietly halves somebody's history is not something you notice by
 * looking at the dashboard.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildInsert,
  clip,
  normCountry,
  normDate,
  normDevice,
  normOs,
  normSource,
  PAGE_VIEW_COLUMNS,
  resolveColumns,
  rowKey,
  SESSION_COLUMNS,
  splitCsv,
  synthesizeRecord,
  toRecord,
} from '../../app/Analytics/ga-import'
import { buildAssertion, GA4_SCOPE, importWarnings, normalizePropertyId, parseServiceAccountKey, redactKey, toRecords } from '../../app/Analytics/ga4'
import * as googleAuth from '../../app/Analytics/google-auth'
import { SCOPE_ANALYTICS_READONLY } from '../../app/Analytics/google-auth'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const REC = {
  date: '2024-01-15',
  path: '/pricing',
  source: 'google',
  medium: 'organic',
  campaign: 'brand',
  country: 'United States',
  device: 'desktop',
  browser: 'Chrome',
  os: 'Mac OS X',
  pageviews: '10',
  sessions: '4',
  users: '2',
}

describe('normalization', () => {
  test('GA dates arrive in two shapes', () => {
    expect(normDate('20240115')).toBe('2024-01-15')
    expect(normDate('2024-01-15')).toBe('2024-01-15')
    expect(normDate('2024-01-15T00:00:00Z')).toBe('2024-01-15')
  })

  test('a country name becomes a code, or nothing', () => {
    // page_views.country is varchar(2). Truncating "Netherlands" to "Ne" would
    // put a country that does not exist in the report.
    expect(normCountry('United States')).toBe('US')
    expect(normCountry('gb')).toBe('GB')
    expect(normCountry('Narnia')).toBeNull()
    expect(normCountry('')).toBeNull()
  })

  test('macOS has four spellings in GA and one here', () => {
    expect(normOs('Mac OS X')).toBe('macOS')
    expect(normOs('Macintosh')).toBe('macOS')
    expect(normOs('')).toBe('Unknown')
  })

  test('device is lowercased to match what the tracker writes', () => {
    expect(normDevice('Desktop')).toBe('desktop')
    expect(normDevice('')).toBe('unknown')
  })

  test('every way GA spells "no referrer" means Direct', () => {
    for (const v of ['', '(direct)', '(none)', 'Direct', 'DIRECT'])
      expect(normSource(v)).toBe('Direct')
    expect(normSource('google')).toBe('google')
  })

  test('clip is a hard bound, since these columns are varchar', () => {
    expect(clip('abcdef', 3)).toBe('abc')
    expect(clip('ab', 8)).toBe('ab')
  })
})

describe('toRecord', () => {
  test('the ordinary row', () => {
    const r = toRecord(REC)!
    expect(r.date).toBe('2024-01-15')
    expect(r.pageviews).toBe(10)
    expect(r.sessions).toBe(4)
    expect(r.users).toBe(2)
    expect(r.country).toBe('US')
    expect(r.os).toBe('macOS')
  })

  test('a row with no usable date is dropped, not defaulted', () => {
    // Defaulting to today would file years-old traffic under this morning.
    expect(toRecord({ ...REC, date: 'not-a-date' })).toBeNull()
    expect(toRecord({ ...REC, date: '' })).toBeNull()
  })

  test('a row with no views is dropped', () => {
    expect(toRecord({ ...REC, pageviews: '0' })).toBeNull()
  })

  test('sessions cannot exceed pageviews', () => {
    // GA's metrics come from different passes and disagree at the margins. An
    // unclamped pair gives a session with zero views and divides by zero later.
    const r = toRecord({ ...REC, pageviews: '3', sessions: '99' })!
    expect(r.sessions).toBe(3)
  })

  test('users cannot exceed sessions', () => {
    const r = toRecord({ ...REC, pageviews: '10', sessions: '2', users: '99' })!
    expect(r.users).toBe(2)
  })

  test('neither can be zero when there is traffic', () => {
    const r = toRecord({ ...REC, pageviews: '5', sessions: '0', users: '0' })!
    expect(r.sessions).toBeGreaterThanOrEqual(1)
    expect(r.users).toBeGreaterThanOrEqual(1)
  })

  test('a missing sessions column is estimated, not assumed to be zero', () => {
    const r = toRecord({ date: '2024-01-15', pageviews: '10', sessionsMissing: true, usersMissing: true })!
    expect(r.sessions).toBe(5)
    expect(r.users).toBe(5)
  })

  test('a missing pageviews column falls back to sessions', () => {
    // An export with Sessions but no Views is common; treating it as no traffic
    // would silently import nothing and report success.
    const r = toRecord({ date: '2024-01-15', sessions: '7', pageviewsMissing: true, usersMissing: true })!
    expect(r.pageviews).toBe(7)
  })
})

describe('synthesis', () => {
  const rec = toRecord(REC)!
  const out = synthesizeRecord('site-1', rec, new Date('2026-01-01T00:00:00Z'))

  test('reproduces GA\'s totals exactly', () => {
    // The whole contract: the dashboard must report what GA reported.
    expect(out.pageViews.length).toBe(10)
    expect(out.sessions.length).toBe(4)
  })

  test('and GA\'s unique-visitor count', () => {
    expect(new Set(out.pageViews.map(p => p.visitor_id)).size).toBe(2)
  })

  test('views are dealt evenly across sessions', () => {
    // 10 across 4 == 3,3,2,2. A lumpy distribution would show up as a fake
    // pages-per-session outlier.
    const counts = out.sessions.map(s => s.page_view_count).sort()
    expect(counts).toEqual([2, 2, 3, 3])
  })

  test('a one-view session is a bounce, and that is where bounce rate comes from', () => {
    const single = synthesizeRecord('site-1', toRecord({ ...REC, pageviews: '4', sessions: '4', users: '4' })!, new Date())
    expect(single.sessions.every(s => s.is_bounce)).toBe(true)
    expect(out.sessions.every(s => s.is_bounce)).toBe(false)
  })

  test('every row is marked synthetic', () => {
    // The gap_/gas_ prefixes are what let --replace remove a GA import without
    // touching real traffic or a Fathom import.
    expect(out.pageViews.every(p => String(p.id).startsWith('gap_'))).toBe(true)
    expect(out.sessions.every(s => String(s.id).startsWith('gas_'))).toBe(true)
  })

  test('page views land inside their own day', () => {
    for (const p of out.pageViews)
      expect(String(p.timestamp).slice(0, 10)).toBe('2024-01-15')
  })

  test('referrer_source is normalized even though source is kept raw', () => {
    // The record keeps what GA said; the row gets the normalized value. Both
    // matter: the raw string feeds the id, the normalized one feeds the report.
    const direct = toRecord({ ...REC, source: '(direct)' })!
    expect(direct.source).toBe('(direct)')
    const rows = synthesizeRecord('site-1', direct, new Date())
    expect(rows.sessions[0].referrer_source).toBe('Direct')
  })

  test('ids are deterministic, so a re-import overwrites rather than doubles', () => {
    const again = synthesizeRecord('site-1', rec, new Date('2030-06-06T00:00:00Z'))
    expect(again.pageViews.map(p => p.id)).toEqual(out.pageViews.map(p => p.id))
  })

  test('and are scoped to the site', () => {
    const other = synthesizeRecord('site-2', rec, new Date())
    expect(other.pageViews[0].id).not.toBe(out.pageViews[0].id)
  })

  test('the id key uses the DEFAULTED source', () => {
    // Pinned deliberately. This string reproduces the key the CSV importer used
    // before the synthesis moved into the shared module; changing it silently
    // doubles the history of anyone who re-imports without --replace.
    const blank = toRecord({ ...REC, source: '' })!
    const rows = synthesizeRecord('site-1', blank, new Date())
    const expected = rowKey(`site-1|2024-01-15|/pricing|Direct|US|desktop|Chrome|macOS`)
    expect(String(rows.sessions[0].id)).toBe(`gas_${expected}_0`)
  })

  test('rowKey is the same hash the CLI helper produces', async () => {
    // scripts/analytics/lib.ts uses crypto.subtle; this uses node:crypto. Same
    // algorithm, and a re-import across the two must not produce new ids.
    const input = 'site|2024-01-15|/|google|US|desktop|Chrome|macOS'
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
    const viaSubtle = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
    expect(rowKey(input)).toBe(viaSubtle)
  })
})

describe('the insert', () => {
  const rows = synthesizeRecord('site-1', toRecord(REC)!, new Date())

  test('one statement per batch, not one per row', () => {
    const built = buildInsert('page_views', rows.pageViews)!
    expect(built.params.length).toBe(rows.pageViews.length * PAGE_VIEW_COLUMNS.length)
    expect((built.sql.match(/\(\$/g) ?? []).length).toBe(rows.pageViews.length)
  })

  test('re-running cannot error on a duplicate id', () => {
    // Without this a re-import aborts partway and leaves half a history.
    expect(buildInsert('sessions', rows.sessions)!.sql).toContain('ON CONFLICT (id) DO NOTHING')
  })

  test('an empty batch is null, not an invalid statement', () => {
    expect(buildInsert('page_views', [])).toBeNull()
  })

  test('every column the synthesis writes is a column the insert names', () => {
    // A key the synthesis sets but the column list omits is silently dropped —
    // the row inserts fine and the data is just missing.
    for (const key of Object.keys(rows.sessions[0]))
      expect(SESSION_COLUMNS).toContain(key as any)
    for (const key of Object.keys(rows.pageViews[0]))
      expect(PAGE_VIEW_COLUMNS).toContain(key as any)
  })
})

describe('CSV parsing', () => {
  test('quoted fields with commas survive', () => {
    expect(splitCsv('a,"b,c",d')).toEqual(['a', 'b,c', 'd'])
  })

  test('escaped quotes survive', () => {
    expect(splitCsv('a,"say ""hi""",c')).toEqual(['a', 'say "hi"', 'c'])
  })

  test('GA4 column names are matched loosely, because they vary', () => {
    const cols = resolveColumns(['Date', 'Page path and screen class', 'Session source', 'Views', 'Sessions', 'Total users'])
    expect(cols.date).toBe(0)
    expect(cols.path).toBe(1)
    expect(cols.source).toBe(2)
    expect(cols.pageviews).toBe(3)
    expect(cols.users).toBe(5)
  })
})

describe('the service-account key', () => {
  test('a wrong-file mistake is named, not just rejected', () => {
    // People reach for the OAuth client secret. "Invalid JSON" would send them
    // looking in the wrong place.
    const r = parseServiceAccountKey('{"installed":{"client_id":"x"}}') as { error: string }
    expect(r.error).toContain('OAuth client secret')
  })

  test('the error never quotes the input', () => {
    const r = parseServiceAccountKey('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----') as { error: string }
    expect(r.error).not.toContain('secret')
    expect(r.error).not.toContain('BEGIN PRIVATE KEY')
  })

  test('redaction survives a PEM embedded in other text', () => {
    const text = `error: -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- while signing`
    expect(redactKey(text)).not.toContain('BEGIN PRIVATE KEY')
    expect(redactKey(text)).toContain('while signing')
  })

  test('and catches a bare base64 blob with no PEM header', () => {
    // Google echoes fragments of a malformed assertion; those have no header.
    expect(redactKey(`assertion ${'A'.repeat(200)} rejected`)).toContain('[redacted]')
  })

  test('the scope requested is read-only', () => {
    // A service account with edit rights on someone's analytics property is not
    // something an importer should ever ask for.
    //
    // Asserted on the VALUE rather than by grepping ga4.ts for the literal. The
    // scope moved into google-auth.ts when Search Console became the second
    // caller (#25), and a source-grep test would have gone green-because-absent
    // rather than failing — the string was simply no longer in the file it was
    // looking at.
    expect(SCOPE_ANALYTICS_READONLY).toBe('https://www.googleapis.com/auth/analytics.readonly')
    expect(GA4_SCOPE).toBe(SCOPE_ANALYTICS_READONLY)
  })

  test('every Google scope in the codebase is read-only', () => {
    // The rule is about all of them, not just GA4's, and it has to keep holding
    // as APIs are added. Any exported SCOPE_* that does not end in `.readonly`
    // is a service account asking for write access to a customer's property.
    const scopes = Object.entries(googleAuth)
      .filter(([name, value]) => name.startsWith('SCOPE_') && typeof value === 'string') as Array<[string, string]>
    expect(scopes.length).toBeGreaterThan(0)
    for (const [name, value] of scopes) {
      expect(`${name}=${value}`).toMatch(/\.readonly$/)
      expect(value.startsWith('https://www.googleapis.com/auth/')).toBe(true)
    }
  })

  test('the assertion is a well-formed RS256 JWT', () => {
    const key = {
      client_email: 'a@b.iam.gserviceaccount.com',
      // A syntactically valid throwaway key would need generating; buildAssertion
      // is exercised for real against a fake Google in the e2e probe. Here we
      // only pin that an unusable key fails loudly rather than emitting an
      // unsigned token.
      private_key: 'not a key',
    }
    expect(() => buildAssertion(key, GA4_SCOPE)).toThrow()
  })
})

describe('the Data API reader', () => {
  test('a property id is accepted in either spelling', () => {
    expect(normalizePropertyId('properties/123456789')).toBe('123456789')
    expect(normalizePropertyId(' 123456789 ')).toBe('123456789')
  })

  test('and refused when it is not the numeric id', () => {
    // GA4 shows a "G-XXXX" measurement id prominently; it is not the property id.
    expect(normalizePropertyId('G-ABC123')).toBeNull()
    expect(normalizePropertyId('')).toBeNull()
  })

  test('"(other)" rows are counted and dropped, never imported', () => {
    // Real traffic under a fake label. Importing it puts a page called "(other)"
    // in the pages report, which reads as a real page.
    const rows = [{
      dimensionValues: [{ value: '20240101' }, { value: '(other)' }, { value: 'google' }, { value: '' }, { value: '' }, { value: 'United States' }, { value: 'desktop' }, { value: 'Chrome' }, { value: 'Windows' }],
      metricValues: [{ value: '500' }, { value: '100' }, { value: '50' }],
    }]
    const out = toRecords(rows)
    expect(out.records).toEqual([])
    expect(out.other).toBe(1)
  })

  test('dimension order is positional, so the two lists must stay aligned', () => {
    // GA4 names nothing in the response — it returns values in the order they
    // were requested. If GA4_DIMENSIONS is reordered without updating toRecords,
    // every page becomes a country and nothing errors.
    const src = code('app/Analytics/ga4.ts')
    const dims = src.match(/GA4_DIMENSIONS = \[([^\]]+)\]/)![1]
    const order = [...dims.matchAll(/'([^']+)'/g)].map(m => m[1])
    expect(order).toEqual(['date', 'pagePath', 'sessionSource', 'sessionMedium', 'sessionCampaignName', 'country', 'deviceCategory', 'browser', 'operatingSystem'])
  })
})

describe('the two importers stay one implementation', () => {
  test('neither CLI re-implements the synthesis', () => {
    // The whole reason app/Analytics/ga-import.ts exists. A second copy would be
    // free to drift, and the symptom is a customer's numbers changing depending
    // on which importer they used.
    for (const script of ['scripts/analytics/import-ga.ts', 'scripts/analytics/import-ga4.ts']) {
      const src = code(script)
      expect(src).toContain('synthesizeRecord')
      expect(src).not.toContain('gas_${')
      expect(src).not.toContain('page_view_count:')
    }
  })

  test('the HTTP endpoint uses it too', () => {
    const src = code('routes/analytics.ts')
    expect(src).toContain('synthesizeRecord')
  })

  test('the endpoint is owner-gated', () => {
    // It writes history and --replace deletes a prior import; viewer or admin is
    // not enough.
    const src = code('routes/analytics.ts')
    const route = src.slice(src.indexOf(`route.post('/api/sites/{siteId}/import/ga4'`))
    expect(route.slice(0, 400)).toContain('requireSiteOwner')
  })

  test('the endpoint never stores the key', () => {
    // The one thing that must stay true. If a future change wants to remember
    // the connection, that is a stored Google credential and its own decision.
    const src = code('routes/analytics.ts')
    const start = src.indexOf(`route.post('/api/sites/{siteId}/import/ga4'`)
    const route = src.slice(start, src.indexOf('route.', start + 10))
    expect(route).not.toMatch(/INSERT INTO sites|UPDATE sites|settings\s*=/)
    expect(route).not.toContain('console.log')
  })

  test('the endpoint hands its incompleteness to importWarnings', () => {
    // Pinned as a call, not as a mention of the word "capped" — a grep for that
    // stays green when the branch has been disabled, which is exactly how this
    // test was vacuous on the first pass.
    const src = code('routes/analytics.ts')
    const route = src.slice(src.indexOf(`route.post('/api/sites/{siteId}/import/ga4'`))
    expect(route).toContain('importWarnings({')
    expect(route).toContain('warnings,')
  })
})

describe('a partial import always says so', () => {
  // Silence is the dangerous outcome: months later it reads as a traffic drop
  // that never happened, and nobody thinks to blame the importer.
  const clean = { capped: false, truncated: false, other: 0, maxRows: 50_000 }

  test('a complete import warns about nothing', () => {
    expect(importWarnings(clean)).toEqual([])
  })

  test('hitting the per-request cap is reported, with the number', () => {
    const w = importWarnings({ ...clean, capped: true })
    expect(w.length).toBe(1)
    expect(w[0]).toContain('50,000')
    expect(w[0]).toContain('incomplete')
  })

  test('running out of pages is reported', () => {
    expect(importWarnings({ ...clean, truncated: true })[0]).toContain('shorter periods')
  })

  test('traffic Google bucketed is reported, with the count', () => {
    const w = importWarnings({ ...clean, other: 1234 })
    expect(w[0]).toContain('1,234')
    expect(w[0]).toContain('not imported')
  })

  test('zero bucketed rows is not a warning', () => {
    // `if (history.other)` vs `if (history.other >= 0)` — the second warns on
    // every clean import and trains people to ignore the panel.
    expect(importWarnings({ ...clean, other: 0 })).toEqual([])
  })

  test('all three at once are all reported', () => {
    expect(importWarnings({ capped: true, truncated: true, other: 5, maxRows: 10 }).length).toBe(3)
  })
})
