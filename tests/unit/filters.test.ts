/**
 * The filter grammar and saved segments (#23).
 *
 * The SQL these produce is executed against a real Postgres separately — the two
 * claims worth proving there are that a negation includes rows with no value, and
 * that `%` in a `contains` value is a literal. Both are the kind of bug that
 * returns a smaller number instead of an error, so neither is left to a unit test
 * that would only re-state the code.
 *
 * What is here is the parsing and the shape of the generated SQL: which params
 * count as filters, which are ignored, what an operator compiles to, and the
 * wiring a later edit could quietly loosen.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildFilterSql,
  collectFilters,
  FILTER_COLUMNS,
  isFilterOp,
  MAX_FILTERS,
  MAX_PATTERN_LENGTH,
  mergeFilters,
  parseFilterKey,
  parseSegmentFilters,
  validateFilters,
} from '../../app/Analytics/filters'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Source with comments stripped — match code, not the prose describing it. */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('parsing a filter parameter', () => {
  test('a bare dimension is still equality', () => {
    // Every existing dashboard link and click-to-filter URL depends on this.
    expect(parseFilterKey('country')).toEqual({ key: 'country', op: 'eq' })
    expect(parseFilterKey('path')).toEqual({ key: 'path', op: 'eq' })
  })

  test('the operator rides in the name', () => {
    expect(parseFilterKey('path__not')).toEqual({ key: 'path', op: 'not' })
    expect(parseFilterKey('path__contains')).toEqual({ key: 'path', op: 'contains' })
    expect(parseFilterKey('path__matches')).toEqual({ key: 'path', op: 'matches' })
    expect(parseFilterKey('path__not_matches')).toEqual({ key: 'path', op: 'not_matches' })
  })

  test('unknown dimensions and operators are not filters', () => {
    // Returning null rather than throwing matters: these arrive mixed with
    // startDate, segment and paging params, which must pass through untouched.
    for (const param of ['nonsense', 'path__wat', '__matches', 'pathmatches', 'country__', 'startDate', 'segment'])
      expect(parseFilterKey(param), param).toBeNull()
  })

  test('every declared dimension parses', () => {
    for (const key of Object.keys(FILTER_COLUMNS))
      expect(parseFilterKey(key), key).toEqual({ key, op: 'eq' })
  })

  test('operators are matched, never defaulted', () => {
    for (const bad of ['', 'EQ', 'like', 'regex', null, 1])
      expect(isFilterOp(bad)).toBe(false)
  })
})

describe('collecting filters from a bag', () => {
  test('ignores everything that is not a filter', () => {
    const specs = collectFilters({
      country: 'US',
      startDate: '2026-01-01',
      segment: 'abc',
      page: '2',
      nonsense: 'x',
    })
    expect(specs).toEqual([{ key: 'country', op: 'eq', value: 'US' }])
  })

  test('ignores empty values rather than filtering on emptiness', () => {
    // `?country=` is what a cleared dropdown sends. Treating it as `country = ''`
    // would return nothing and look like a bug in the data.
    expect(collectFilters({ country: '', path: '/x' })).toEqual([{ key: 'path', op: 'eq', value: '/x' }])
  })

  test('ignores non-string values', () => {
    expect(collectFilters({ country: ['US'], path: 5, browser: null })).toEqual([])
  })
})

describe('validation', () => {
  test('caps how many filters combine', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_FILTERS + 1 }, (_, i) => [`path__contains`, `v${i}`]),
    )
    // Object keys collapse, so build the spec list directly for this one.
    const specs = Array.from({ length: MAX_FILTERS + 1 }, (_, i) => ({ key: 'path', op: 'contains' as const, value: `v${i}` }))
    expect(validateFilters(specs)).toHaveProperty('error')
    expect(Object.keys(many).length).toBe(1) // sanity: the bag really does collapse
  })

  test('caps pattern length', () => {
    const ok = { key: 'path', op: 'matches' as const, value: 'a'.repeat(MAX_PATTERN_LENGTH) }
    const tooLong = { key: 'path', op: 'matches' as const, value: 'a'.repeat(MAX_PATTERN_LENGTH + 1) }
    expect(validateFilters([ok])).toEqual({ ok: true })
    expect(validateFilters([tooLong])).toHaveProperty('error')
  })

  test('a long literal value is fine — only patterns are capped tighter', () => {
    // The pattern cap exists to bound the state machine Postgres builds, not to
    // limit what someone can search for.
    expect(validateFilters([{ key: 'path', op: 'eq', value: 'a'.repeat(250) }])).toEqual({ ok: true })
    expect(validateFilters([{ key: 'path', op: 'eq', value: 'a'.repeat(256) }])).toHaveProperty('error')
  })
})

describe('the generated SQL', () => {
  test('equality is unchanged from before this feature', () => {
    const { sql, params } = buildFilterSql([{ key: 'country', op: 'eq', value: 'US' }])
    expect(sql).toBe(' AND country = ?')
    expect(params).toEqual(['US'])
  })

  test('negation includes rows with no value at all', () => {
    // `country <> 'US'` is NULL — and therefore false — for a visitor we could
    // not geolocate, so the obvious spelling silently drops them. Verified
    // against real Postgres; asserted here so the spelling cannot regress.
    expect(buildFilterSql([{ key: 'country', op: 'not', value: 'US' }]).sql).toContain('IS DISTINCT FROM')

    const notMatches = buildFilterSql([{ key: 'path', op: 'not_matches', value: '^/admin' }]).sql
    expect(notMatches).toContain('path IS NULL OR')
    expect(notMatches).toContain('!~')
  })

  test('contains uses POSITION, so % is never a wildcard', () => {
    // With LIKE, a `%` inside the parameterised value is still a wildcard, so
    // `?path__contains=50%` would match far more than it says.
    const { sql } = buildFilterSql([{ key: 'path', op: 'contains', value: '50%' }])
    expect(sql).toContain('POSITION(')
    expect(sql).not.toContain('LIKE')
  })

  test('filters compose with AND, and every value is a parameter', () => {
    const { sql, params } = buildFilterSql([
      { key: 'country', op: 'eq', value: 'US' },
      { key: 'path', op: 'matches', value: '^/blog/' },
    ])
    expect((sql.match(/ AND /g) ?? []).length).toBe(2)
    expect(params).toEqual(['US', '^/blog/'])
    // The value must never appear in the SQL text itself.
    expect(sql).not.toContain('US')
    expect(sql).not.toContain('^/blog/')
  })

  test('an unknown dimension contributes no SQL', () => {
    expect(buildFilterSql([{ key: 'nope' as never, op: 'eq', value: 'x' }])).toEqual({ sql: '', params: [] })
  })
})

describe('saved segments', () => {
  test('a segment is the same bag as query params', () => {
    expect(parseSegmentFilters('{"country":"US","path__matches":"^/blog/"}'))
      .toEqual({ country: 'US', path__matches: '^/blog/' })
  })

  test('junk in a stored segment is dropped rather than executed', () => {
    // The column is text and could hold anything after a bad write or a restore.
    expect(parseSegmentFilters('{"path":"/x","evil__drop":"1","count":5,"empty":""}')).toEqual({ path: '/x' })
    expect(parseSegmentFilters('{oops')).toEqual({})
    expect(parseSegmentFilters('[1,2]')).toEqual({})
    expect(parseSegmentFilters(null)).toEqual({})
  })

  test('request params win over the saved definition', () => {
    // A segment is a starting point the reader narrows by clicking. A save that
    // overrode the last click would make the dashboard feel broken.
    expect(mergeFilters({ country: 'US', device: 'Mobile' }, { device: 'Desktop' }))
      .toEqual({ country: 'US', device: 'Desktop' })
  })
})

describe('the wiring a later edit could quietly loosen', () => {
  const routes = code('routes/analytics.ts')

  test('every report endpoint goes through the segment-aware reader', () => {
    // Filters, operators and segments all arrive through one function. An
    // endpoint calling the bare reader would silently ignore ?segment=.
    expect(routes).toContain('readFiltersWithSegment(request, siteId)')
    expect((routes.match(/readFiltersWithSegment\(request, siteId\)/g) ?? []).length).toBe(5)
  })

  test('a segment from another site cannot narrow this one', () => {
    const i = routes.indexOf('async function readFiltersWithSegment')
    const block = routes.slice(i, i + 900)
    expect(block).toContain('WHERE id = ? AND site_id = ?')
  })

  test('reading segments is a viewer right, writing is admin', () => {
    const gates: Array<[string, string]> = [
      [`route.get('/api/sites/{siteId}/segments'`, 'viewer'],
      [`route.post('/api/sites/{siteId}/segments'`, 'admin'],
      [`route.patch('/api/sites/{siteId}/segments/{segmentId}'`, 'admin'],
      [`route.delete('/api/sites/{siteId}/segments/{segmentId}'`, 'admin'],
    ]
    for (const [path, rank] of gates) {
      const i = routes.indexOf(path)
      expect(i, `${path} is missing`).toBeGreaterThan(-1)
      const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
      expect(block, path).toContain(`requireSiteRole(request, siteId, '${rank}')`)
    }
  })

  test('a bad pattern is a 400, not an uncaught 500', () => {
    // Postgres is the authority on POSIX regex syntax — pre-checking with
    // `new RegExp` would reject valid patterns and accept invalid ones — so its
    // complaint is caught and translated rather than escaping the handler.
    expect(routes).toContain(`String(e?.errno) !== '2201B'`)
    expect(routes).toContain('That pattern is not valid')
    // Every filtered query must run through the wrapper that does the catching.
    expect((routes.match(/await filteredQuery\(/g) ?? []).length).toBe(5)
  })

  test('and a query failure that is not the caller\'s fault still throws', () => {
    // Reporting our own broken SQL as a 400 would blame the user and hide the bug.
    const i = routes.indexOf('async function filteredQuery')
    const block = routes.slice(i, i + 500)
    expect(block).toContain('throw error')
  })
})
