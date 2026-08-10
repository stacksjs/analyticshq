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
  test('geo stops at country', () => {
    expect(privacy.geo.granularity).toBe('country')
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

  test('there is no city or region option, by construction', () => {
    // Widening geo should require a product decision and a copy change, not a
    // config edit — /compare/plausible contrasts us with their city-level data.
    const src = read('config/privacy.ts')
    const type = src.slice(src.indexOf('granularity:'), src.indexOf('granularity:') + 60)
    expect(type).not.toContain('city')
    expect(type).not.toContain('region')
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
    expect(routes).toContain("privacy.geo.granularity === 'country'")
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
