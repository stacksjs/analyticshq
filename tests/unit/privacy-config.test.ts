/**
 * Privacy configuration (issue #11).
 *
 * Every privacy-affecting behaviour used to be a constant buried in whichever
 * file needed it: a salt window in app/Analytics/salt.ts, a session window in
 * routes/analytics.ts, geo granularity implied by which helper got called, DNT
 * split between the tracker and the ingest. An operator could not see what the
 * product does, let alone change it.
 *
 * The risk with a config file is that it becomes decorative — values declared in
 * one place and ignored in another. So these tests check two separate things:
 * that the defaults are the posture we publish, and that each call site actually
 * reads the config rather than a literal.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import privacy from '../../config/privacy'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('the defaults are the posture the comparison pages claim (#11)', () => {
  test('no site records anything finer than country without its owner acting', () => {
    // The claim on the comparison pages is about what is RECORDED, and that is
    // still country. What enforces it moved: `granularity` is the ceiling and
    // now permits region, so the guarantee rests entirely on sites.region_geo
    // defaulting to false. If that default ever flips, this test is the one that
    // should stop the commit, not the config value above it.
    expect(privacy.geo.granularity).not.toBe('none')
    const migration = read('database/migrations/0000000051-add-opt-in-region-geo.sql')
    expect(migration).toContain('"region_geo" boolean NOT NULL DEFAULT false')
  })

  test('DNT and GPC are respected by default', () => {
    expect(privacy.respectDnt).toBe(true)
  })

  test('neither fingerprint field is collected', () => {
    expect(privacy.collect.pageTitle).toBe(false)
    expect(privacy.collect.screenSize).toBe(false)
  })

  test('salts are kept for two days, not one', () => {
    // One would drop an event arriving just after UTC midnight into a day whose
    // salt is already gone, so it would hash differently and count as a new visitor.
    expect(privacy.saltRetentionDays).toBe(2)
  })

  test('retention is off unless an operator opts in', () => {
    // Keep-forever is the safe default for a self-hoster who has not thought
    // about it; ANALYTICSHQ_RETENTION_DAYS turns pruning on.
    expect(privacy.retentionDays).toBe(0)
  })

  test('there is no city option, by construction', () => {
    // City is the line that does not move. Region became reachable — opt-in per
    // site, off by default — but /compare/plausible and /compare/umami still
    // contrast us with their city-level data, and nothing may make that false.
    //
    // Comments are stripped FIRST, and that is the whole point of this test
    // rather than a detail of it: the previous version sliced from the raw
    // source at `indexOf('granularity:')`, which landed on the mention inside
    // the docblock at the top of the file instead of on the type. It read sixty
    // characters of prose and asserted they were not the word "region", so it
    // passed no matter what the type said.
    const src = read('config/privacy.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const decl = src.slice(src.indexOf('granularity:'), src.indexOf('granularity:') + 60)
    expect(decl).toContain('granularity:')
    expect(decl).not.toContain('city')
    // Proves the slice is the type and not prose, so the assertion above is
    // looking at something that could have failed.
    expect(decl).toContain('region')
  })
})

describe('the call sites read the config, not a literal (#11)', () => {
  const routes = read('routes/analytics.ts')
  const salt = read('app/Analytics/salt.ts')

  test('the session window comes from config', () => {
    expect(routes).toContain('privacy.sessionWindowMinutes')
    expect(routes).not.toContain('30 * 60 * 1000')
  })

  test('the GPC guard is gated on the toggle', () => {
    expect(routes).toMatch(/privacy\.respectDnt\s*&&[\s\S]{0,60}sec-gpc/)
  })

  test('geo resolution is gated on granularity', () => {
    // 'none' is the only value that records nothing, so the country gate reads
    // as "not none" rather than naming the two values that do resolve — a list
    // that would have to be edited again to add a third.
    expect(routes).toContain("privacy.geo.granularity !== 'none'")
  })

  test('region needs the install to permit it AND the site to ask', () => {
    // Either half alone must record nothing. The instance check comes first and
    // returns before any query, so a default install pays nothing for a feature
    // it has not enabled.
    expect(routes).toContain("privacy.geo.granularity !== 'region'")
    expect(routes).toMatch(/siteWantsRegion\([\s\S]{0,40}\?\s*regionFromIp/)
  })

  test('the ceiling permits region and the per-site default withholds it', () => {
    // Raising the ceiling was deliberate: it lets a site owner turn regions on
    // without an operator editing config first. It changes nothing on its own,
    // and the two things that still have to be true are asserted elsewhere —
    // the site's own flag (privacy-guardrails.test.ts) and a geolocation
    // database that carries subdivisions (geo.test.ts).
    expect(privacy.geo.granularity).toBe('region')
    expect(routes).toContain("privacy.geo.granularity !== 'region'")
  })

  test('salt purging uses the configured window', () => {
    expect(salt).toContain('privacy.saltRetentionDays')
    expect(salt).not.toMatch(/RETENTION_DAYS\s*=\s*\d/)
  })

  test('retention parsing has one implementation, not two', () => {
    // config/privacy.ts and scripts/analytics/prune.ts must agree on what
    // "unset / 0 / negative / non-numeric" means, so they share the helper.
    //
    // Comments are stripped first: the env var is *named* in the doc comment
    // that explains it, and matching that is the same false positive stx's own
    // codemod and strict-mode guard have (stacksjs/stx#1905, #1911).
    const src = read('config/privacy.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).toContain('retentionDays()')
    expect(src).not.toContain('process.env.ANALYTICSHQ_RETENTION_DAYS')
  })
})
