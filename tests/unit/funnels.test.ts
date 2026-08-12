/**
 * Funnels (#21).
 *
 * The counting is SQL and is verified against a real Postgres, because mocking a
 * query would only prove the mock. What is tested here is everything that decides
 * before the query runs — validation, the generated SQL's shape, the arithmetic
 * on the way out — plus the wiring a later edit could quietly loosen.
 *
 * The property this file exists to protect: a funnel is AGGREGATE. No identity
 * may leave the query. That is asserted against the generated SQL rather than
 * trusted to a comment, because "we only select counts" is exactly the kind of
 * claim that stays in a docblock after someone adds a debugging column.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildFunnelSql,
  computeFunnel,
  isFunnelScope,
  MAX_STEPS,
  parseSteps,
  validateSteps,
} from '../../app/Analytics/funnels'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Source with comments stripped — match code, not the prose describing it. */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('step validation', () => {
  test('a funnel needs at least two steps', () => {
    expect(validateSteps([])).toHaveProperty('error')
    expect(validateSteps(['g1'])).toHaveProperty('error')
    expect(validateSteps(['g1', 'g2'])).toEqual({ steps: ['g1', 'g2'] })
  })

  test('and is capped, because nobody reads a twelve-step chart', () => {
    const tooMany = Array.from({ length: MAX_STEPS + 1 }, (_, i) => `g${i}`)
    expect(validateSteps(tooMany)).toHaveProperty('error')
  })

  test('the same goal cannot appear twice', () => {
    // With one conversion row per session per goal, a repeated step can never be
    // advanced past — it would render as a guaranteed 100% drop-off, which is a
    // broken report that looks like a finding.
    expect(validateSteps(['g1', 'g2', 'g1'])).toHaveProperty('error')
  })

  test('non-strings are rejected rather than coerced', () => {
    for (const bad of [['g1', 2], ['g1', null], ['g1', ''], ['g1', '  '], 'g1,g2', null, undefined, {}])
      expect(validateSteps(bad as never), JSON.stringify(bad)).toHaveProperty('error')
  })

  test('scopes are matched, never defaulted', () => {
    expect(isFunnelScope('session')).toBe(true)
    expect(isFunnelScope('day')).toBe(true)
    for (const bad of ['', 'Session', 'week', 'visitor', null, 1])
      expect(isFunnelScope(bad)).toBe(false)
  })

  test('a malformed stored column reads as no steps, not a crash', () => {
    expect(parseSteps('{oops')).toEqual([])
    expect(parseSteps(null)).toEqual([])
    expect(parseSteps('"not an array"')).toEqual([])
    expect(parseSteps('["g1", 2, "g2"]')).toEqual(['g1', 'g2'])
  })
})

describe('the generated query is aggregate by construction', () => {
  test('the outer projection is counts and nothing else', () => {
    // Anchored at the end of the statement. Note `lastIndexOf('SELECT')` finds
    // the innermost COUNT subquery, not the outer projection — a probe of this
    // got that wrong before the assertion was anchored.
    for (const scope of ['session', 'day'] as const) {
      for (const steps of [2, 3, 8]) {
        const sql = buildFunnelSql(steps, scope)
        expect(
          / SELECT \(SELECT COUNT\(\*\) FROM s\d+\) AS c\d+(, \(SELECT COUNT\(\*\) FROM s\d+\) AS c\d+)*$/.test(sql),
          `${scope}/${steps}`,
        ).toBe(true)
      }
    }
  })

  test('no identity column survives into the projection', () => {
    // The identity is needed inside the CTEs to join steps together, and must not
    // reach the result. This is the line between an aggregate funnel and a
    // per-person path export.
    for (const scope of ['session', 'day'] as const) {
      const sql = buildFunnelSql(4, scope)
      const projection = sql.slice(sql.lastIndexOf(') SELECT ') + 2)
      expect(projection).not.toContain('visitor_id')
      expect(projection).not.toContain('session_id')
      expect(projection).not.toContain('ident')
    }
  })

  test('each step is required to happen at or after the one before it', () => {
    // Without this a funnel is three goal counts in a row, and would report a
    // checkout completed by someone who hit the thank-you page first.
    const sql = buildFunnelSql(3, 'session')
    expect(sql).toContain('e.at >= p.at')
    expect((sql.match(/e\.at >= p\.at/g) ?? []).length).toBe(2) // steps 2 and 3
  })

  test('at or after, not strictly after', () => {
    // One beacon can satisfy two goals ("/pricing" and "any page"), writing rows
    // with an identical timestamp. `>` would report a 100% drop at step 2 for a
    // funnel both of whose steps were genuinely reached.
    expect(buildFunnelSql(2, 'session')).not.toContain('e.at > p.at')
  })

  test('the day scope makes the UTC day part of the identity', () => {
    // A visitor hash is only meaningful within the day whose salt produced it.
    // Grouping by the hash alone across days would silently join two strangers.
    const day = buildFunnelSql(2, 'day')
    expect(day).toContain('SUBSTRING(timestamp FROM 1 FOR 10)')
    expect(buildFunnelSql(2, 'session')).not.toContain('SUBSTRING')
  })

  test('null identities are excluded rather than grouped together', () => {
    // Every row with a null session_id would otherwise become one enormous
    // pseudo-visitor that completes every funnel.
    expect(buildFunnelSql(2, 'session')).toContain('session_id IS NOT NULL')
    expect(buildFunnelSql(2, 'day')).toContain('visitor_id IS NOT NULL')
  })
})

describe('the arithmetic a reader acts on', () => {
  // computeFunnel against a site with no rows: the query returns nothing and the
  // shaping still has to produce sane numbers.
  test('an empty funnel is zeroes, not NaN', async () => {
    const result = await computeFunnel('no-such-site', ['g1', 'g2'], 'session', new Date('2026-08-01'), new Date('2026-08-08'))
    expect(result.steps.map(s => s.count)).toEqual([0, 0])
    // A NaN here reaches the API as `null` in JSON and renders as an empty chart
    // that looks like a loading state.
    expect(result.steps.map(s => s.fromStart)).toEqual([0, 0])
    expect(result.steps.map(s => s.fromPrevious)).toEqual([0, 0])
    expect(result.steps.every(s => Number.isFinite(s.fromStart))).toBe(true)
  })

  test('a step whose goal was deleted still renders, rather than renumbering', async () => {
    // Dropping it would shift every later step up and change what the chart
    // claims happened.
    const result = await computeFunnel('no-such-site', ['g1', 'g2'], 'session', new Date('2026-08-01'), new Date('2026-08-02'))
    expect(result.steps.map(s => s.name)).toEqual(['(deleted goal)', '(deleted goal)'])
  })

  test('a multi-day range is flagged when identity resets nightly', async () => {
    // The salt behind visitor_id rotates at midnight UTC, so a `day`-scoped
    // funnel over a week is a sum of seven funnels. Saying so is the difference
    // between a number and a misleading number.
    const week = await computeFunnel('s', ['g1', 'g2'], 'day', new Date('2026-08-01T00:00:00Z'), new Date('2026-08-08T00:00:00Z'))
    expect(week.spansMultipleDays).toBe(true)

    const oneDay = await computeFunnel('s', ['g1', 'g2'], 'day', new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T23:59:59Z'))
    expect(oneDay.spansMultipleDays).toBe(false)

    // Session scope is unaffected: a session cannot span midnight-to-midnight in
    // a way that changes who someone is.
    const session = await computeFunnel('s', ['g1', 'g2'], 'session', new Date('2026-08-01T00:00:00Z'), new Date('2026-08-08T00:00:00Z'))
    expect(session.spansMultipleDays).toBe(false)
  })
})

describe('the wiring a later edit could quietly loosen', () => {
  const routes = code('routes/analytics.ts')

  test('reading a funnel is a viewer right, writing is admin', () => {
    // Unlike alerts: a funnel definition holds no delivery credential, and its
    // results are the same aggregate numbers a viewer already reaches through the
    // goals report. Matching goals rather than alerts is the right precedent.
    const gates: Array<[string, string]> = [
      [`route.get('/api/sites/{siteId}/funnels'`, 'viewer'],
      [`route.get('/api/sites/{siteId}/funnels/{funnelId}/results'`, 'viewer'],
      [`route.post('/api/sites/{siteId}/funnels'`, 'admin'],
      [`route.patch('/api/sites/{siteId}/funnels/{funnelId}'`, 'admin'],
      [`route.delete('/api/sites/{siteId}/funnels/{funnelId}'`, 'admin'],
    ]
    for (const [path, rank] of gates) {
      const i = routes.indexOf(path)
      expect(i, `${path} is missing`).toBeGreaterThan(-1)
      const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
      expect(block, path).toContain(`requireSiteRole(request, siteId, '${rank}')`)
    }
  })

  test('every step must be a goal on this site', () => {
    // Otherwise an admin on one site names another site's goal and reads its
    // conversion counts out of the funnel — the same cross-site leak the alerts
    // endpoint closes for goal_id.
    expect(routes).toContain('these steps are not goals on this site')
    // On create AND on update: validating only the create path leaves the edit
    // path as the way in.
    expect((routes.match(/these steps are not goals on this site/g) ?? []).length).toBe(2)
  })

  test('the update and results paths are scoped by site as well as funnel id', () => {
    for (const path of [
      `route.patch('/api/sites/{siteId}/funnels/{funnelId}'`,
      `route.get('/api/sites/{siteId}/funnels/{funnelId}/results'`,
    ]) {
      const i = routes.indexOf(path)
      const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
      expect(block, path).toContain('AND site_id = ?')
    }
  })

  test('no endpoint returns anything per-person', () => {
    // The funnel section must never select an identity column. If a future edit
    // needs one, this test is the conversation about whether it should.
    //
    // The section is located in the RAW source, because its boundaries are
    // comments and `code()` has already removed them — then the extract is
    // stripped, so the assertion still matches code rather than prose.
    const raw = read('routes/analytics.ts')
    const start = raw.indexOf('// Funnels (#21)')
    const end = raw.indexOf('// Shareable read-only links', start)
    expect(start, 'the funnel section marker is gone').toBeGreaterThan(-1)
    expect(end, 'the section end marker is gone').toBeGreaterThan(start)

    const section = raw.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    expect(section).not.toContain('visitor_id')
    expect(section).not.toContain('SELECT session_id')
    // And the section is actually substantial — an empty slice would pass the
    // two assertions above while proving nothing.
    expect(section.length).toBeGreaterThan(1000)
  })
})
