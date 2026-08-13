/**
 * The minimum-segment-population floor (#40).
 *
 * Segments narrow a population before a count is taken; every filter is
 * individually aggregate and innocuous. Composed, they are not: on a seeded
 * 61-visitor site, `country=IS` + `device=tablet` matches exactly one person, and
 * a funnel over that segment reports their whole journey.
 *
 * The counting half runs against a real Postgres. What is here is the decision —
 * which is where the subtle errors live, because every one of them is a failure
 * to withhold, and a failure to withhold looks exactly like working software.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldSuppress } from '../../app/Analytics/filters'
import privacy from '../../config/privacy'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('the decision', () => {
  const K = 5

  test('a segment below the floor is withheld', () => {
    expect(shouldSuppress(K, 2, 1)).toBe(true)
    expect(shouldSuppress(K, 2, 4)).toBe(true)
  })

  test('at the floor exactly, it serves', () => {
    // `<` not `<=`. Off by one here silently withholds a report that was fine,
    // which is the failure people notice and then "fix" by lowering k.
    expect(shouldSuppress(K, 2, 5)).toBe(false)
    expect(shouldSuppress(K, 2, 6)).toBe(false)
  })

  test('an UNFILTERED report is never withheld, however small', () => {
    // "You had 3 visitors yesterday" identifies nobody. The disclosure comes from
    // narrowing, not from smallness — and hiding a new install's own totals would
    // make the product look broken rather than careful.
    expect(shouldSuppress(K, 0, 1)).toBe(false)
    expect(shouldSuppress(K, 0, 0)).toBe(false)
  })

  test('k = 0 disables the guard entirely', () => {
    expect(shouldSuppress(0, 3, 1)).toBe(false)
  })

  test('a negative k cannot switch it into some other behaviour', () => {
    expect(shouldSuppress(-1, 3, 1)).toBe(false)
  })

  test('an unknown population fails CLOSED', () => {
    // segmentPopulation returns null when the count cannot be established. A
    // guard that fails open is not a guard: a database blip would serve exactly
    // the report this exists to withhold.
    expect(shouldSuppress(K, 2, null)).toBe(true)
  })

  test('an empty segment is withheld too', () => {
    // Zero is below the floor. Serving it would confirm "nobody matches this
    // description", which is itself an answer about a narrow population.
    expect(shouldSuppress(K, 2, 0)).toBe(true)
  })
})

describe('the configured default', () => {
  test('is on, and is a sane k', () => {
    // A privacy guard that ships disabled is decoration. 5 is the conventional
    // k for disclosure control and small enough that an ordinary site never
    // notices it.
    expect(privacy.minSegmentSize).toBeGreaterThanOrEqual(1)
    expect(privacy.minSegmentSize).toBeLessThanOrEqual(50)
  })

  test('a malformed env var fails to the default rather than to off', () => {
    // Unlike retentionDays, where unset means disabled. Here a typo that silently
    // switched the guard off would be a privacy regression nothing reports.
    const source = code('config/privacy.ts')
    const i = source.indexOf('function minSegmentSize')
    expect(i).toBeGreaterThan(-1)
    const block = source.slice(i, i + 500)
    // Every early return in the parser must be the default, never 0.
    const returns = block.match(/return \S+/g) ?? []
    expect(returns.length).toBeGreaterThan(2)
    expect(returns.filter(r => /return 0\b/.test(r))).toEqual([])
  })
})

describe('the wiring a later edit could quietly loosen', () => {
  const routes = code('routes/analytics.ts')

  test('every filtered report endpoint consults the floor', () => {
    // Five endpoints read filters; all five must check. One that does not is a
    // way around the guard rather than an oversight in a corner.
    const reads = (routes.match(/readFiltersWithSegment\(request, siteId\)/g) ?? []).length
    const guards = (routes.match(/suppressedResponse\(siteId, from, to, flt\)/g) ?? []).length
    expect(reads).toBe(5)
    expect(guards).toBe(reads)
  })

  test('the guard runs before the report query, not after', () => {
    // Computing the report and then withholding it would leave the answer in
    // logs and timing, and would cost the query anyway.
    const i = routes.indexOf('async function suppressedResponse')
    expect(i).toBeGreaterThan(-1)
    for (const marker of ['const withheld = await suppressedResponse']) {
      let from = 0
      let seen = 0
      while (true) {
        const at = routes.indexOf(marker, from)
        if (at === -1)
          break
        seen++
        const nextQuery = routes.indexOf('await filteredQuery(', at)
        expect(nextQuery, 'a guard with no query after it').toBeGreaterThan(at)
        from = at + marker.length
      }
      expect(seen).toBe(5)
    }
  })

  test('the refusal does not name the population it is withholding', () => {
    // "Suppressed because 1" discloses the number the guard exists to hide.
    const i = routes.indexOf('async function suppressedResponse')
    const block = routes.slice(i, routes.indexOf('\n}', i))
    expect(block).toContain('minSegmentSize: minimum')
    expect(block).not.toMatch(/population(?!\s*(=|\)|,|\s*===|\s*null))/)
    expect(block).not.toContain('population,')
  })

  test('it answers 422, not a 200 carrying zeroes', () => {
    // A suppressed report returned as a success is indistinguishable from a real
    // report of zero, and any client that forgot the flag renders "0 visitors" as
    // though it were measured.
    const i = routes.indexOf('async function suppressedResponse')
    const block = routes.slice(i, routes.indexOf('\n}', i))
    expect(block).toContain('}, 422)')
    expect(block).toContain('suppressed: true')
  })

  test('an unfiltered request short-circuits before counting', () => {
    // The floor costs one COUNT(DISTINCT) per filtered request. An unfiltered
    // report can never be suppressed, so paying for the count would be waste on
    // the most common request there is.
    const i = routes.indexOf('async function suppressedResponse')
    const block = routes.slice(i, routes.indexOf('\n}', i))
    const early = block.indexOf('flt.count === 0')
    const counted = block.indexOf('segmentPopulation(')
    expect(early).toBeGreaterThan(-1)
    expect(early).toBeLessThan(counted)
  })
})
