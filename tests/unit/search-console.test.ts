/**
 * Search Console import (#25).
 *
 * The issue was open on a product question — whether SEO/BI integrations mean
 * taking a standing dependency on Google. They do not, and the first block below
 * is what holds that answer in place: a service account the customer creates,
 * a read-only scope, and no application registered with Google.
 *
 * After that: the property identifier (the single thing people get wrong), the
 * folding of API rows, and the arithmetic — CTR and average position are both
 * easy to aggregate incorrectly in ways that look plausible on a dashboard.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as googleAuth from '../../app/Analytics/google-auth'
import { SCOPE_SEARCH_CONSOLE_READONLY } from '../../app/Analytics/google-auth'
import {
  buildSearchInsert,
  defaultEndDate,
  defaultStartDate,
  isAnonymizedRow,
  normalizeSiteUrl,
  runSearchAnalytics,
  SEARCH_CONSOLE_SCOPE,
  SEARCH_DIMENSIONS,
  searchConsoleError,
  searchImportWarnings,
  searchRowId,
  toPath,
  toSearchRecords,
} from '../../app/Analytics/search-console'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

// The SQL equivalent. Migrations here carry more prose than DDL, and every
// forbidden string this file checks for is also NAMED in a comment explaining
// why it is absent — so asserting against the raw file matches the explanation
// and fails on a schema that is correct.
const sqlCode = (p: string) => read(p).replace(/^\s*--.*$/gm, '')

describe('the Google dependency #25 was blocked on', () => {
  test('the scope is read-only', () => {
    expect(SEARCH_CONSOLE_SCOPE).toBe(SCOPE_SEARCH_CONSOLE_READONLY)
    expect(SEARCH_CONSOLE_SCOPE).toBe('https://www.googleapis.com/auth/webmasters.readonly')
    expect(SEARCH_CONSOLE_SCOPE).toMatch(/\.readonly$/)
  })

  test('auth is the shared service-account signer, not a second copy', () => {
    // Two JWT signers agree right up until one is fixed, and a subtly wrong
    // assertion presents as a 401 from Google with no clue which half is at
    // fault. There is one signer.
    const src = code('app/Analytics/search-console.ts')
    expect(src).toContain(`from './google-auth'`)
    expect(src).not.toContain('createSign')
    expect(src).not.toContain('RS256')
  })

  test('no OAuth client registration is implied anywhere', () => {
    // The whole point of the service-account path: we register no application
    // with Google and hold no refresh token for a customer's Google account.
    const src = code('app/Analytics/search-console.ts') + code('app/Analytics/google-auth.ts')
    expect(src).not.toContain('client_secret')
    expect(src).not.toContain('refresh_token')
    expect(src).not.toContain('oauth2/v2/auth')
    expect(src).not.toContain('response_type=code')
  })

  test('the credential is never stored', () => {
    // It is used for one token exchange and dropped. An import endpoint that
    // persisted a key to the database would be holding a credential to somebody
    // else's Google property indefinitely.
    const route = code('routes/analytics.ts')
    const endpoint = route.slice(route.indexOf(`route.post('/api/sites/{siteId}/import/search-console'`))
    const block = endpoint.slice(0, endpoint.indexOf('}).middleware'))
    expect(block).not.toMatch(/INSERT INTO sites/i)
    expect(block).not.toMatch(/UPDATE\s+sites/i)
    expect(block).not.toContain('console.log')
    expect(block).not.toMatch(/body\.key[^\n]*(?:INSERT|UPDATE|log)/i)
  })
})

describe('the property identifier', () => {
  test('a domain property passes through, lowercased', () => {
    expect(normalizeSiteUrl('sc-domain:Example.com')).toBe('sc-domain:example.com')
  })

  test('a bare hostname becomes a domain property', () => {
    // What people actually paste. Left alone it 404s, which reads as "no data".
    expect(normalizeSiteUrl('example.com')).toBe('sc-domain:example.com')
    expect(normalizeSiteUrl('  sub.example.co.uk  ')).toBe('sc-domain:sub.example.co.uk')
  })

  test('a URL-prefix property keeps its trailing slash', () => {
    // Search Console stores it with one and the API path must match exactly.
    expect(normalizeSiteUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeSiteUrl('https://example.com/')).toBe('https://example.com/')
    expect(normalizeSiteUrl('https://example.com/blog')).toBe('https://example.com/blog/')
  })

  test('domain and URL-prefix properties stay distinct', () => {
    // They are different properties holding different data. Collapsing them
    // would import one and report the other.
    expect(normalizeSiteUrl('https://example.com/')).not.toBe(normalizeSiteUrl('sc-domain:example.com'))
  })

  test('nonsense is refused rather than guessed at', () => {
    expect(normalizeSiteUrl('')).toBeNull()
    expect(normalizeSiteUrl('   ')).toBeNull()
    expect(normalizeSiteUrl('not a domain')).toBeNull()
    expect(normalizeSiteUrl('sc-domain:')).toBeNull()
    expect(normalizeSiteUrl('sc-domain:localhost')).toBeNull()
  })
})

describe('turning result URLs into paths', () => {
  test('an absolute URL becomes the path page_views stores', () => {
    // Otherwise the SEO report and the pages report name the same page two
    // different ways and nothing can be lined up.
    expect(toPath('https://example.com/pricing')).toBe('/pricing')
    expect(toPath('https://example.com/')).toBe('/')
    expect(toPath('https://example.com/a/b?c=d#e')).toBe('/a/b')
  })

  test('something already a path survives', () => {
    expect(toPath('/pricing')).toBe('/pricing')
    expect(toPath('pricing')).toBe('/pricing')
  })

  test('empty is the root, not the empty string', () => {
    expect(toPath('')).toBe('/')
  })

  test('a path is clipped to the column width', () => {
    expect(toPath(`https://example.com/${'x'.repeat(400)}`).length).toBe(255)
  })
})

describe('folding API rows', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    keys: ['2026-01-15', 'privacy analytics', 'https://example.com/pricing'],
    clicks: 4,
    impressions: 100,
    ctr: 0.04,
    position: 7.5,
    ...over,
  })

  test('the ordinary row', () => {
    const { records } = toSearchRecords([row()])
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      date: '2026-01-15',
      query: 'privacy analytics',
      path: '/pricing',
      clicks: 4,
      impressions: 100,
      position: 7.5,
    })
  })

  test('the dimension order is the one the request asked for', () => {
    // The API returns a positional `keys` array and names nothing, so the
    // constant that builds the request must be the one that reads the reply.
    expect([...SEARCH_DIMENSIONS]).toEqual(['date', 'query', 'page'])
  })

  test('anonymized rows are counted and dropped, never stored', () => {
    // Real traffic under a placeholder. Stored, it puts a search term called
    // "anonymized query" at the top of the report.
    const { records, anonymized } = toSearchRecords([
      row({ keys: ['2026-01-15', '', 'https://example.com/'] }),
      row({ keys: ['2026-01-15', 'anonymized query', 'https://example.com/'] }),
      row(),
    ])
    expect(anonymized).toBe(2)
    expect(records).toHaveLength(1)
    expect(records.every(r => r.query !== '')).toBe(true)
  })

  test('isAnonymizedRow recognises the shapes Google uses', () => {
    expect(isAnonymizedRow({ keys: ['2026-01-15', '', '/'] })).toBe(true)
    expect(isAnonymizedRow({ keys: ['2026-01-15', 'Anonymized Query', '/'] })).toBe(true)
    expect(isAnonymizedRow({ keys: ['2026-01-15', 'real query', '/'] })).toBe(false)
  })

  test('a row with no usable date is dropped, not defaulted', () => {
    // Defaulting to today would file old search data under this morning.
    const { records, skipped } = toSearchRecords([row({ keys: ['nope', 'q', '/'] })])
    expect(records).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  test('a row with no impressions describes nothing and is dropped', () => {
    const { records, skipped } = toSearchRecords([row({ impressions: 0, clicks: 0 })])
    expect(records).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  test('clicks cannot exceed impressions', () => {
    // You cannot be clicked more often than you were shown. Unclamped, this
    // renders as a CTR above 100%.
    const { records } = toSearchRecords([row({ clicks: 500, impressions: 100 })])
    expect(records[0].clicks).toBe(100)
  })

  test('a fractional position survives', () => {
    // Average position is fractional and small movements are the whole signal.
    const { records } = toSearchRecords([row({ position: 3.7 })])
    expect(records[0].position).toBe(3.7)
  })

  test('a long query is clipped to the column width', () => {
    const { records } = toSearchRecords([row({ keys: ['2026-01-15', 'q'.repeat(400), '/'] })])
    expect(records[0].query.length).toBe(255)
  })
})

describe('row identity', () => {
  test('the same row imports to the same id, so a re-import converges', () => {
    // Search Console revises the last few days, so re-importing an overlapping
    // range is normal and must update rather than double.
    const rec = { date: '2026-01-15', query: 'q', path: '/p', clicks: 1, impressions: 2, position: 3 }
    return Promise.all([searchRowId('site', rec), searchRowId('site', { ...rec, clicks: 99, position: 1 })])
      .then(([a, b]) => expect(a).toBe(b))
  })

  test('different queries, pages, days or sites are different rows', async () => {
    const rec = { date: '2026-01-15', query: 'q', path: '/p', clicks: 1, impressions: 2, position: 3 }
    const base = await searchRowId('site', rec)
    expect(await searchRowId('other', rec)).not.toBe(base)
    expect(await searchRowId('site', { ...rec, date: '2026-01-16' })).not.toBe(base)
    expect(await searchRowId('site', { ...rec, query: 'other' })).not.toBe(base)
    expect(await searchRowId('site', { ...rec, path: '/other' })).not.toBe(base)
  })

  test('the insert updates the counts on conflict rather than ignoring them', () => {
    // DO NOTHING would keep the first numbers ever seen and never pick up
    // Google's revisions, so the dashboard would drift from Search Console with
    // no way to resync short of --replace.
    const stmt = buildSearchInsert([{ id: 'a', site_id: 's', date: '2026-01-15', query: 'q', path: '/p', clicks: 1, impressions: 2, position: 3 }])!
    expect(stmt.sql).toContain('ON CONFLICT (id) DO UPDATE')
    expect(stmt.sql).toContain('clicks = EXCLUDED.clicks')
    expect(stmt.sql).toContain('impressions = EXCLUDED.impressions')
    expect(stmt.sql).toContain('position = EXCLUDED.position')
    expect(stmt.sql).not.toContain('DO NOTHING')
  })

  test('the placeholder count matches the column count', () => {
    const stmt = buildSearchInsert([
      { id: 'a', site_id: 's', date: '2026-01-15', query: 'q', path: '/p', clicks: 1, impressions: 2, position: 3 },
      { id: 'b', site_id: 's', date: '2026-01-16', query: 'q', path: '/p', clicks: 1, impressions: 2, position: 3 },
    ])!
    expect(stmt.params).toHaveLength(16)
    expect(stmt.sql.match(/\?/g)).toHaveLength(16)
  })

  test('an empty batch is not a statement', () => {
    expect(buildSearchInsert([])).toBeNull()
  })
})

describe('the date window', () => {
  test('the default start is 16 months back, which is all Google keeps', () => {
    // Asking for more is not an error — Google silently returns less, which
    // reads as "the site had no traffic in 2019" rather than "Google does not
    // have it".
    expect(defaultStartDate(new Date('2026-08-17T00:00:00Z'))).toBe('2025-04-17')
  })

  test('the default end is yesterday, since final data excludes today', () => {
    expect(defaultEndDate(new Date('2026-08-17T00:00:00Z'))).toBe('2026-08-16')
  })
})

describe('warnings', () => {
  test('nothing wrong says nothing', () => {
    expect(searchImportWarnings({ truncated: false, anonymized: 0, skipped: 0 })).toEqual([])
  })

  test('withheld queries are reported, not silently missing', () => {
    // The impressions really happened; the query is unavailable to everyone,
    // including us. A total that quietly excludes them looks like lost traffic.
    const [w] = searchImportWarnings({ truncated: false, anonymized: 1234, skipped: 0 })
    expect(w).toContain('1,234')
    expect(w).toMatch(/too few people/i)
  })

  test('a truncated import says it is incomplete', () => {
    const [w] = searchImportWarnings({ truncated: true, anonymized: 0, skipped: 0 })
    expect(w).toMatch(/incomplete/i)
  })

  test('every failure mode produces its own line', () => {
    expect(searchImportWarnings({ truncated: true, anonymized: 5, skipped: 2 })).toHaveLength(3)
  })
})

describe('Google refusals', () => {
  test('a 403 names the fix, not the symptom', () => {
    // Google's own message sends people to check their Google account. The
    // actual cause is always that the SERVICE ACCOUNT was not granted access.
    const msg = searchConsoleError(403, 'User does not have sufficient permission', 'sc-domain:example.com')
    expect(msg).toMatch(/Users and permissions/)
    expect(msg).toMatch(/service account/i)
    expect(msg).toContain('sc-domain:example.com')
  })

  test('a 404 explains the two property kinds', () => {
    const msg = searchConsoleError(404, 'not found', 'example.com')
    expect(msg).toMatch(/sc-domain:/)
    expect(msg).toMatch(/trailing slash/)
  })

  test('anything else still surfaces the status and body', () => {
    expect(searchConsoleError(500, 'backend error', 'x')).toContain('500')
    expect(searchConsoleError(500, 'backend error', 'x')).toContain('backend error')
  })
})

describe('the API request', () => {
  const fakeFetch = (pages: unknown[][]) => {
    const seen: any[] = []
    let call = 0
    const impl = (async (_url: string, init: any) => {
      seen.push({ url: _url, body: JSON.parse(init.body) })
      const rows = pages[call++] ?? []
      return { ok: true, json: async () => ({ rows }), text: async () => '' } as any
    }) as unknown as typeof fetch
    return { impl, seen }
  }

  test('asks for web results only, and only finalised data', async () => {
    // Discover and News are separate surfaces that would double-count, and
    // non-final data changes after import and is never corrected.
    const { impl, seen } = fakeFetch([[]])
    await runSearchAnalytics('tok', 'sc-domain:example.com', { startDate: '2026-01-01', endDate: '2026-01-31' }, impl)
    expect(seen[0].body.type).toBe('web')
    expect(seen[0].body.dataState).toBe('final')
    expect(seen[0].body.dimensions).toEqual(['date', 'query', 'page'])
  })

  test('the property is URL-encoded into the path', async () => {
    // "sc-domain:example.com" contains a colon, and an unencoded one changes
    // which resource the path addresses.
    const { impl, seen } = fakeFetch([[]])
    await runSearchAnalytics('tok', 'sc-domain:example.com', { startDate: '2026-01-01', endDate: '2026-01-31' }, impl)
    expect(seen[0].url).toContain('sc-domain%3Aexample.com')
    expect(seen[0].url).not.toContain('sc-domain:example.com')
  })

  test('stops paging when a short page arrives', async () => {
    const { impl, seen } = fakeFetch([[{ keys: ['2026-01-15', 'q', '/'] }]])
    const out = await runSearchAnalytics('tok', 'sc-domain:x.com', { startDate: 'a', endDate: 'b' }, impl)
    expect(seen).toHaveLength(1)
    expect(out.rows).toHaveLength(1)
    expect(out.truncated).toBe(false)
  })

  test('a refusal throws with the actionable message', async () => {
    const impl = (async () => ({ ok: false, status: 403, text: async () => 'denied' })) as unknown as typeof fetch
    await expect(runSearchAnalytics('tok', 'sc-domain:x.com', { startDate: 'a', endDate: 'b' }, impl))
      .rejects.toThrow(/Users and permissions/)
  })
})

describe('the read endpoint', () => {
  const src = code('routes/analytics.ts')

  test('is viewer-gated like every other report', () => {
    const route = src.slice(src.indexOf(`route.get('/api/sites/{siteId}/search'`))
    expect(route.slice(0, 400)).toContain(`requireSiteRole(request, siteId, 'viewer')`)
  })

  test('importing requires the owner, since it takes a credential', () => {
    const route = src.slice(src.indexOf(`route.post('/api/sites/{siteId}/import/search-console'`))
    expect(route.slice(0, 400)).toContain('requireSiteOwner(request, siteId)')
  })

  test('CTR is computed from the stored counts, never selected from a column', () => {
    // Storing it means two sources for one number that disagree after a partial
    // import, with no way to tell which is right.
    // No query selects a ctr column...
    const queries = src.slice(src.indexOf(`route.get('/api/sites/{siteId}/search'`))
    expect(queries.slice(0, queries.indexOf('}).middleware'))).not.toMatch(/SELECT[^;]*\bctr\b/i)
    // ...and the helpers that shape the response derive it. They sit BELOW the
    // route, which an earlier version of this test sliced away and so asserted
    // against a region that could never contain the thing it looked for.
    const helper = src.slice(src.indexOf('function searchRow('), src.indexOf('route.options(' + JSON.stringify('/api/sites/{siteId}/import/search-console').slice(1, -1)))
    expect(helper).toContain('clicks / impressions')
    expect(helper).toContain('impressions > 0')
  })

  test('average position is impression-weighted, not a plain average', () => {
    // A plain AVG treats a query with 2 impressions like one with 20,000 and
    // reports a rank nobody held.
    const route = src.slice(src.indexOf(`route.get('/api/sites/{siteId}/search'`))
    expect(route.slice(0, 2500)).toContain('SUM(position * impressions) / NULLIF(SUM(impressions), 0)')
    expect(route.slice(0, 2500)).not.toMatch(/AVG\(position\)/i)
  })

  test('the date bounds are sliced to a day', () => {
    // `date` is YYYY-MM-DD and the window helper yields ISO timestamps.
    // Comparing them directly drops the last day of every range.
    const route = src.slice(src.indexOf(`route.get('/api/sites/{siteId}/search'`))
    expect(route.slice(0, 1200)).toContain(`String(from).slice(0, 10)`)
    expect(route.slice(0, 1200)).toContain(`String(to).slice(0, 10)`)
  })
})

describe('the table sits outside the erasure path, deliberately', () => {
  const route = code('routes/analytics.ts')

  test('search_queries is not in the visitor erasure list', () => {
    // "Delete everything about this visitor" cannot reach rows that were never
    // about a visitor. Adding it would mean inventing a visitor_id to erase by,
    // which is exactly the linkage the schema avoids.
    const tables = route.match(/const EVENT_TABLES = \[([^\]]+)\]/)
    expect(tables).not.toBeNull()
    expect(tables![1]).not.toContain('search_queries')
  })

  test('the table has no visitor column to erase by', () => {
    const migration = sqlCode('database/migrations/0000000049-create-search_queries-table.sql')
    expect(migration).not.toContain('visitor_id')
    expect(migration).not.toContain('session_id')
  })

  test('it still cascades when the site is deleted', () => {
    const migration = sqlCode('database/migrations/0000000049-create-search_queries-table.sql')
    expect(migration).toContain('ON DELETE CASCADE')
  })

  test('position is a float, not an integer', () => {
    // An integer column rounds every SEO report to whole positions and loses
    // the movement that is the point of tracking it.
    const migration = sqlCode('database/migrations/0000000049-create-search_queries-table.sql')
    expect(migration).toMatch(/"position"\s+double precision/)
  })

  test('there is no ctr column', () => {
    const migration = sqlCode('database/migrations/0000000049-create-search_queries-table.sql')
    expect(migration).not.toMatch(/"ctr"/)
  })

  test('retention reaches it, at day granularity', () => {
    // The date column is YYYY-MM-DD; compared against a full ISO cutoff it would
    // delete the cutoff day too, because the shorter string sorts first.
    const prune = code('scripts/analytics/prune.ts')
    expect(prune).toContain(`'search_queries'`)
    expect(prune).toContain(`granularity === 'date' ? cutoff.slice(0, 10) : cutoff`)
  })
})

describe('the dashboard panel', () => {
  const view = read('resources/views/dashboard.stx')

  test('renders only once an import has happened', () => {
    // An empty panel advertises the feature as broken rather than unconfigured.
    expect(view).toContain('@if (searchQueries.length)')
  })

  test('queries by site and range only, never with the filter SQL', () => {
    const start = view.indexOf('searchQueries = (await pgq(')
    expect(start).toBeGreaterThan(0)
    const query = view.slice(start, view.indexOf('LIMIT 10', start))
    expect(query).toContain('WHERE site_id = ? AND date >= ? AND date <= ?')
    expect(query).not.toContain('${filter}')
  })

  test('slices the range bounds to a day', () => {
    const start = view.indexOf('searchQueries = (await pgq(')
    expect(view.slice(start, start + 900)).toContain('String(from).slice(0, 10)')
  })

  test('derives CTR in the view rather than reading a column', () => {
    const start = view.indexOf('@if (searchQueries.length)')
    const panel = view.slice(start, view.indexOf('Entry / exit pages', start))
    expect(panel).toContain('Number(q.clicks) / Number(q.impressions)')
    expect(panel).not.toMatch(/q\.ctr/)
  })
})

describe('every Google scope stays read-only', () => {
  test('including the one added for Search Console', () => {
    const scopes = Object.entries(googleAuth)
      .filter(([name, value]) => name.startsWith('SCOPE_') && typeof value === 'string') as Array<[string, string]>
    expect(scopes.length).toBeGreaterThanOrEqual(2)
    for (const [name, value] of scopes)
      expect(`${name}=${value}`).toMatch(/\.readonly$/)
  })
})
