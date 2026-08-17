/**
 * BI connector (#25, Looker Studio half).
 *
 * This is the one endpoint in the app that answers without a logged-in user, so
 * most of what is pinned here is the boundary: what it will group by, what it
 * refuses to, and that it cannot reach anything that writes.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONNECT_DIMENSIONS,
  CONNECT_FORBIDDEN_DIMENSIONS,
  CONNECT_MAX_ROWS,
  CONNECT_METRICS,
  describeFields,
  parseFieldList,
  planQuery,
  shapeRow,
  shareTokenVerdict,
  tokenMatches,
} from '../../app/Analytics/connect'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('what the connector will never expose', () => {
  test('no visitor or session identifier is a dimension', () => {
    // The product argument is that a site owner gets counts, not people. A BI
    // tool is where a per-visitor export would be most tempting and least
    // visible, so the restriction lives here rather than in the connector.
    expect(Object.keys(CONNECT_DIMENSIONS)).not.toContain('visitor_id')
    expect(Object.keys(CONNECT_DIMENSIONS)).not.toContain('session_id')
  })

  test('asking for one is refused by name, not as a typo', () => {
    // "unknown dimension: visitor_id" invites someone to go looking for the
    // correct spelling. The refusal says it is not available and why.
    const plan = planQuery({ dimensions: ['visitor_id'], metrics: ['views'] }) as { error: string }
    expect(plan.error).toContain('visitor_id')
    expect(plan.error).toMatch(/counts, not people/)
    expect(plan.error).not.toMatch(/unknown dimension/)
  })

  test('every forbidden dimension is actually absent from the registry', () => {
    // The list and the registry could drift into disagreeing, at which point the
    // named refusal above becomes unreachable and the column becomes groupable.
    for (const name of CONNECT_FORBIDDEN_DIMENSIONS)
      expect(CONNECT_DIMENSIONS[name]).toBeUndefined()
  })

  test('visitors is a COUNT DISTINCT, never the hash itself', () => {
    expect(CONNECT_METRICS.visitors.sql).toMatch(/COUNT\(DISTINCT visitor_id\)/)
    expect(CONNECT_METRICS.visitors.sql).not.toMatch(/^visitor_id$/)
  })
})

describe('field selection is closed', () => {
  test('an unknown dimension is refused, with the available list', () => {
    const plan = planQuery({ dimensions: ['nope'], metrics: ['views'] }) as { error: string }
    expect(plan.error).toContain('nope')
    expect(plan.error).toContain('path')
  })

  test('an unknown metric is refused', () => {
    const plan = planQuery({ dimensions: [], metrics: ['profit'] }) as { error: string }
    expect(plan.error).toContain('profit')
  })

  test('a SQL fragment is refused like any other unknown field', () => {
    // The registry is what makes this safe: nothing from the request is ever
    // interpolated, so this is refused by lookup rather than by escaping.
    const plan = planQuery({ dimensions: [`path); DROP TABLE page_views;--`], metrics: ['views'] }) as { error: string }
    expect(plan.error).toBeTruthy()
    expect('sql' in plan).toBe(false)
  })

  test('no request value ever reaches the SQL string', () => {
    const plan = planQuery({ dimensions: ['date', 'path'], metrics: ['views'] })
    expect('sql' in plan).toBe(true)
    if ('sql' in plan) {
      // Only the three bound parameters, and they are placeholders.
      expect(plan.sql.match(/\?/g)).toHaveLength(3)
      expect(plan.sql).toContain('site_id = ?')
    }
  })

  test('at least one metric is required', () => {
    const plan = planQuery({ dimensions: ['date'], metrics: [] }) as { error: string }
    expect(plan.error).toMatch(/at least one metric/)
  })

  test('duplicate fields collapse rather than producing duplicate columns', () => {
    const plan = planQuery({ dimensions: ['date', 'date'], metrics: ['views', 'views'] })
    if (!('sql' in plan))
      throw new Error(plan.error)
    expect(plan.dimensions).toEqual(['date'])
    expect(plan.metrics).toEqual(['views'])
  })
})

describe('the query it builds', () => {
  test('groups by ordinal, so the date expression exists once', () => {
    // date is a SUBSTRING; repeating it in GROUP BY is a copy that can diverge.
    const plan = planQuery({ dimensions: ['date', 'path'], metrics: ['views'] })
    if (!('sql' in plan))
      throw new Error(plan.error)
    expect(plan.sql).toContain('GROUP BY 1, 2')
    expect(plan.sql.match(/SUBSTRING/g)).toHaveLength(1)
  })

  test('takes the UTC date from the ISO string rather than casting', () => {
    // A cast would forfeit the index every other daily report relies on.
    expect(CONNECT_DIMENSIONS.date.sql).toBe('SUBSTRING(timestamp FROM 1 FOR 10)')
  })

  test('a dimensionless request is a single total row', () => {
    const plan = planQuery({ dimensions: [], metrics: ['views'] })
    if (!('sql' in plan))
      throw new Error(plan.error)
    expect(plan.sql).not.toContain('GROUP BY')
  })

  test('is bounded', () => {
    const plan = planQuery({ dimensions: ['path'], metrics: ['views'] })
    if (!('sql' in plan))
      throw new Error(plan.error)
    expect(plan.sql).toContain(`LIMIT ${CONNECT_MAX_ROWS}`)
  })

  test('reads only page_views', () => {
    const plan = planQuery({ dimensions: ['path'], metrics: ['views'] })
    if (!('sql' in plan))
      throw new Error(plan.error)
    expect(plan.sql).toMatch(/FROM page_views/)
    expect(plan.sql).not.toMatch(/INSERT|UPDATE|DELETE|DROP/i)
  })
})

describe('row shaping', () => {
  test('nulls become empty strings and zeroes, not nulls', () => {
    // Looker Studio renders a null text dimension as an unfilterable blank row,
    // and a null metric breaks its aggregation outright.
    expect(shapeRow({ path: null, views: null }, ['path'], ['views'])).toEqual(['', 0])
  })

  test('dimensions come before metrics, in the requested order', () => {
    // The response is positional and the connector reads it back by index.
    expect(shapeRow({ date: '2026-01-15', path: '/a', views: 5, visitors: 2 }, ['date', 'path'], ['views', 'visitors']))
      .toEqual(['2026-01-15', '/a', 5, 2])
  })

  test('a non-numeric metric becomes 0 rather than NaN', () => {
    expect(shapeRow({ views: 'x' }, [], ['views'])).toEqual([0])
  })
})

describe('parseFieldList', () => {
  test('splits, trims and drops blanks', () => {
    expect(parseFieldList('date, path ,,')).toEqual(['date', 'path'])
  })

  test('absent is empty, not a crash', () => {
    expect(parseFieldList(undefined)).toEqual([])
    expect(parseFieldList('')).toEqual([])
  })

  test('preserves order, since the response is positional', () => {
    expect(parseFieldList('path,date')).toEqual(['path', 'date'])
  })
})

describe('the token check', () => {
  test('matches only an exact token', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true)
    expect(tokenMatches('abc124', 'abc123')).toBe(false)
    expect(tokenMatches('abc12', 'abc123')).toBe(false)
  })

  test('an empty expected token never matches', () => {
    // A site with sharing disabled has no token. An empty-vs-empty compare
    // returning true would open every un-shared site to a blank token.
    expect(tokenMatches('', '')).toBe(false)
    expect(tokenMatches('anything', '')).toBe(false)
  })

  test('is not a plain equality on a secret', () => {
    const src = code('app/Analytics/connect.ts')
    expect(src).toContain('charCodeAt')
    expect(src).not.toMatch(/provided === expected/)
  })
})

describe('the access decision', () => {
  const TOKEN = 'a'.repeat(32)

  test('a correct token for an existing, shared site is allowed', () => {
    expect(shareTokenVerdict(TOKEN, TOKEN, true)).toEqual({ ok: true })
  })

  test('a wrong token is 403', () => {
    // The mutation that matters. When this decision lived inline in the route,
    // replacing the comparison with `if (false)` turned the endpoint into an
    // open data export and every unit test stayed green.
    const v = shareTokenVerdict('b'.repeat(32), TOKEN, true)
    expect(v.ok).toBe(false)
    expect(v).toMatchObject({ status: 403 })
  })

  test('a token of the wrong length is 403, not a prefix match', () => {
    expect(shareTokenVerdict('a', TOKEN, true)).toMatchObject({ ok: false, status: 403 })
    expect(shareTokenVerdict(`${TOKEN}extra`, TOKEN, true)).toMatchObject({ ok: false, status: 403 })
  })

  test('no token is 401, before anything is looked up', () => {
    expect(shareTokenVerdict('', TOKEN, true)).toMatchObject({ ok: false, status: 401 })
    // Even for a site that does not exist: the caller has no credential, and
    // that is the first thing wrong with the request.
    expect(shareTokenVerdict('', '', false)).toMatchObject({ ok: false, status: 401 })
  })

  test('an unknown site is 404', () => {
    expect(shareTokenVerdict(TOKEN, '', false)).toMatchObject({ ok: false, status: 404 })
  })

  test('a site with sharing disabled is 403, whatever the token', () => {
    // No stored token must never mean "any token will do".
    expect(shareTokenVerdict(TOKEN, '', true)).toMatchObject({ ok: false, status: 403 })
    expect(shareTokenVerdict('', '', true)).toMatchObject({ ok: false, status: 401 })
  })

  test('and says sharing is off rather than that the token is wrong', () => {
    // Two different problems with two different fixes. `tokenMatches` refuses an
    // empty expected token anyway, so dropping this branch is not a hole — it
    // is a 403 telling someone to check a token that was never the issue, while
    // the actual fix (enable sharing) goes unmentioned.
    const off = shareTokenVerdict(TOKEN, '', true)
    const wrong = shareTokenVerdict('b'.repeat(32), TOKEN, true)
    if (off.ok || wrong.ok)
      throw new Error('expected both to be refused')
    expect(off.error).toMatch(/not enabled/i)
    expect(wrong.error).toMatch(/not valid/i)
    expect(off.error).not.toBe(wrong.error)
  })

  test('every refusal carries a message that says what to do', () => {
    for (const v of [
      shareTokenVerdict('', TOKEN, true),
      shareTokenVerdict(TOKEN, '', false),
      shareTokenVerdict(TOKEN, '', true),
      shareTokenVerdict('b'.repeat(32), TOKEN, true),
    ]) {
      expect(v.ok).toBe(false)
      if (!v.ok)
        expect(v.error.length).toBeGreaterThan(10)
    }
  })

  test('a refusal never echoes the expected token', () => {
    const v = shareTokenVerdict('b'.repeat(32), TOKEN, true)
    if (!v.ok)
      expect(v.error).not.toContain(TOKEN)
  })
})

describe('the endpoint', () => {
  const src = code('routes/analytics.ts')
  // Bounded on a CODE anchor. An earlier version ended the slice at the
  // "// Saved segments" comment — which code() strips, so indexOf returned -1,
  // the region silently became the rest of the file, and the assertions below
  // were reading other routes.
  const regionEnd = src.indexOf('function validateSegmentFilters')
  const regionStart = src.indexOf(`route.get('/api/connect/{siteId}/fields'`)
  const region = src.slice(regionStart, regionEnd)

  test('is gated on the share token', () => {
    expect(region).toContain('requireShareToken(request, siteId)')
  })

  test('carries no auth middleware, because the token is the credential', () => {
    // A BI tool cannot hold a one-hour bearer token. Asserted so that adding
    // `.middleware('auth')` here — which would look like hardening — fails
    // loudly instead of silently breaking every connected report.
    const report = region.slice(region.indexOf(`route.get('/api/connect/{siteId}/report'`))
    expect(report).not.toContain(`.middleware('auth')`)
  })

  test('only reads', () => {
    // The whole reason this is a dedicated route rather than share-token access
    // to the Stats API: it cannot reach an endpoint that writes because it is
    // not one.
    expect(region).not.toMatch(/INSERT INTO/i)
    expect(region).not.toMatch(/UPDATE\s+\w+\s+SET/i)
    expect(region).not.toMatch(/DELETE FROM/i)
    expect(region).not.toContain('requireSiteOwner')
  })

  test('the route defers to the verdict rather than re-deciding', () => {
    // The decision itself is a pure function, exercised behaviourally in the
    // block below. All that is asserted here is that the handler returns what
    // it says instead of carrying a second copy of the rules.
    const helper = src.slice(src.indexOf('async function requireShareToken'))
    const block = helper.slice(0, helper.indexOf('\n}'))
    expect(block).toContain('shareTokenVerdict(provided, expected, exists)')
    expect(block).toContain('json({ error: verdict.error }, verdict.status)')
  })

  test('accepts the token as a query param or a bearer header', () => {
    // Looker Studio sends whatever the connector puts in the request, and other
    // BI tools differ.
    const helper = src.slice(src.indexOf('async function requireShareToken'))
    expect(helper.slice(0, 800)).toContain('request.query?.token')
    expect(helper.slice(0, 800)).toMatch(/Bearer\\s\+/)
  })

  test('says when a result was capped rather than truncating silently', () => {
    // A chart drawn on part of the data looks like a real decline.
    expect(region).toContain('truncated: shaped.length >= CONNECT_MAX_ROWS')
  })

  test('a bad field list is a 400 that names the field', () => {
    expect(region).toContain(`json({ error: plan.error }, 400)`)
  })
})

describe('the published connector', () => {
  const gs = read('connectors/looker-studio/Code.gs')

  test('uses KEY auth, never OAuth', () => {
    // OAuth would mean registering an application with Google — the standing
    // dependency #25 was open on avoiding.
    expect(gs).toContain('cc.AuthType.KEY')
    expect(gs).not.toContain('AuthType.OAUTH2')
  })

  test('requests only the fields the chart uses', () => {
    // Requesting everything groups by every dimension and pulls a far larger
    // result than the report displays.
    expect(gs).toContain('request.fields')
    expect(gs).toContain('field.isDimension()')
  })

  test('extends the end date to the end of its day', () => {
    // The API compares against ISO timestamps, so a bare `to=2026-01-31` sorts
    // before every timestamp on the 31st and would drop the last day.
    expect(gs).toContain(`'T23:59:59.999Z'`)
  })

  test('converts dates to the format Looker Studio expects', () => {
    expect(gs).toContain('toStudioDate')
    expect(gs).toMatch(/replace\(\/-\/g, ''\)/)
  })

  test('builds its response schema from the full field set', () => {
    // cc.getFields() returns a fresh empty container; selecting ids from it
    // yields an empty schema and a chart with no columns.
    expect(gs).toContain('buildFields().forIds(returnedFields)')
    expect(gs).not.toContain('cc.getFields().forIds')
  })

  test('surfaces the API message rather than a generic failure', () => {
    expect(gs).toContain('JSON.parse(text).error')
    expect(gs).toContain('newUserError()')
  })

  test('every field id it declares exists in the API', () => {
    // The ids are the wire contract: a mismatch is a column that silently
    // returns nothing.
    const declared = [...gs.matchAll(/\.setId\('([a-z_]+)'\)/g)].map(m => m[1])
    const known = new Set([...Object.keys(CONNECT_DIMENSIONS), ...Object.keys(CONNECT_METRICS)])
    const fields = declared.filter(d => d !== 'siteId' && d !== 'host' && d !== 'instructions')
    expect(fields.length).toBeGreaterThan(0)
    for (const f of fields)
      expect(`${f} is in the API`).toBe(known.has(f) ? `${f} is in the API` : `${f} MISSING from the API`)
  })

  test('the manifest declares KEY auth too', () => {
    const manifest = JSON.parse(read('connectors/looker-studio/appsscript.json'))
    expect(manifest.dataStudio.authType).toEqual(['KEY'])
  })
})

describe('the schema endpoint', () => {
  test('describes every field with a type', () => {
    const fields = describeFields()
    expect(fields.length).toBe(Object.keys(CONNECT_DIMENSIONS).length + Object.keys(CONNECT_METRICS).length)
    for (const f of fields)
      expect(['date', 'text', 'number']).toContain(f.type)
  })

  test('distinguishes dimensions from metrics', () => {
    const fields = describeFields()
    expect(fields.find(f => f.name === 'date')!.kind).toBe('dimension')
    expect(fields.find(f => f.name === 'views')!.kind).toBe('metric')
  })
})
