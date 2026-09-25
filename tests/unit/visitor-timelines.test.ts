/**
 * Opt-in visitor timelines: one visitor's visits across a fixed block of up to
 * 30 days, for a site whose owner turned on "Remember returning visitors".
 *
 * The database half (salts, the purge, the timeline query) was exercised
 * against a real Postgres. What is pinned here is the arithmetic of the windows
 * and the wiring a later edit could loosen: who may turn it on, who may read
 * it, and that nothing outlives its block.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { purgeSaltsQuery } from '../../app/Analytics/salt-purge'
import { clampWindowDays, saltDateFor, windowStartFor } from '../../app/Analytics/salt'
import { isVisitorId } from '../../app/Analytics/visitors'
import { placeLabel, timeAgo, visitorLabel } from '../../app/Support/visitor-format'
import privacy from '../../config/privacy'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const routes = read('routes/analytics.ts')
const block = (start: string) => {
  const i = routes.indexOf(start)
  return routes.slice(i, routes.indexOf('\nroute.', i + 10))
}

describe('windows', () => {
  test('a 1-day window is exactly the old daily salt', () => {
    // Every site that never opts in must keep the ids it always had.
    for (const at of ['2026-09-25T00:00:00Z', '2026-09-25T23:59:59Z', '2026-01-01T12:00:00Z']) {
      const d = new Date(at)
      expect(windowStartFor(d, 1)).toBe(saltDateFor(d))
    }
  })

  test('a 30-day window is one fixed block, the same for every day in it', () => {
    const start = windowStartFor(new Date('2026-09-04T00:00:00Z'), 30)
    expect(start).toBe('2026-09-04')
    expect(windowStartFor(new Date('2026-09-25T21:30:00Z'), 30)).toBe(start)
    expect(windowStartFor(new Date('2026-10-03T23:59:59Z'), 30)).toBe(start)
    // The next block starts a fresh salt: nothing carries over the boundary.
    expect(windowStartFor(new Date('2026-10-04T00:00:00Z'), 30)).toBe('2026-10-04')
  })

  test('a bad window shortens linkage rather than lengthening it', () => {
    for (const bad of [0, -3, 1.5, Number.NaN, '30', null, undefined])
      expect(clampWindowDays(bad, 30)).toBe(bad === '30' ? 30 : 1)
    expect(clampWindowDays(365, 30)).toBe(30)
    expect(clampWindowDays(30, 1)).toBe(1)
  })

  test('the install ceiling is 30 days', () => {
    expect(privacy.maxVisitorWindowDays).toBe(30)
  })
})

describe('the purge', () => {
  test('keeps a daily salt for today and yesterday, and a long one for its block', () => {
    const { sql, params } = purgeSaltsQuery(new Date('2026-09-25T12:00:00Z'), 2, 30)
    expect(params).toEqual(['2026-09-23', 30])
    // The window is read per site, as it is now, and clamped to the ceiling.
    expect(sql).toContain('SELECT s.visitor_window_days FROM sites s WHERE s.id = vs.site_id')
    expect(sql).toContain('LEAST(GREATEST(COALESCE(')
    expect(sql).toMatch(/^DELETE FROM visitor_salts/)
  })

  test('runs every day whether or not event retention is on', () => {
    // It used to exist and be called by nothing, so production kept every salt
    // since the table was created and old ids stayed reversible.
    const prune = read('scripts/analytics/prune.ts')
    const purge = prune.indexOf('purgeSaltsQuery(')
    const retentionExit = prune.indexOf('if (!cutoff)')
    expect(purge).toBeGreaterThan(-1)
    expect(purge).toBeLessThan(retentionExit)
    expect(read('app/Scheduler.ts')).toContain('scripts/analytics/prune.ts')
  })
})

describe('who may turn it on, and who may read it', () => {
  test('only the site owner can turn it on, and not above the install ceiling', () => {
    const patch = block(`route.patch('/api/sites/{siteId}'`)
    const i = patch.indexOf('body.visitorTimelines !== undefined')
    const section = patch.slice(i, patch.indexOf('if (!sets.length)'))
    expect(section).toContain('requireSiteOwner(request, siteId)')
    expect(section).toContain('privacy.maxVisitorWindowDays < 2')
    expect(section).toContain('}, 409)')
  })

  test('turning it off deletes the site\'s long salts at once', () => {
    const patch = block(`route.patch('/api/sites/{siteId}'`)
    expect(patch).toContain('DELETE FROM visitor_salts WHERE site_id = ? AND salt_date < ?')
  })

  test('both endpoints need a role on the site and the opt-in', () => {
    for (const path of [`route.get('/api/sites/{siteId}/visitors'`, `route.get('/api/sites/{siteId}/visitors/{visitorId}'`]) {
      const b = block(path)
      expect(b).toContain(`requireSiteRole(request, siteId, 'viewer')`)
      expect(b).toContain('timelinesEnabled(String(siteId))')
      expect(b).toContain(`.middleware('auth')`)
    }
  })

  test('the ingest hashes with the site\'s window, read fail-closed', () => {
    expect(routes).toContain('getVisitorSalt(String(siteId), windowDays)')
    expect(routes).not.toContain('getDailySalt(')
  })

  test('the visitor page resolves a role before querying, and only an owner can erase', () => {
    const view = read('resources/views/visitor.stx')
    expect(view).toContain(`satisfies(role, 'viewer')`)
    expect(view.indexOf(`satisfies(role, 'viewer')`)).toBeLessThan(view.indexOf('visitorTimeline(siteParam'))
    expect(view).toContain(`const canErase = role === 'owner'`)
  })

  test('a share link never gets the Visitors panel', () => {
    // visitorTimelines is only ever set inside the non-share branch.
    const dash = read('resources/views/dashboard.stx')
    expect(dash).toContain('if (visitorTimelines && !shareMode)')
    const set = dash.indexOf('visitorTimelines = Number(')
    const branch = dash.lastIndexOf('if (viewGranted && !shareMode)', set)
    expect(branch).toBeGreaterThan(-1)
  })
})

describe('what a visitor looks like', () => {
  test('ids are hashes, and nothing else is looked up', () => {
    expect(isVisitorId('0aa8b328fdde66fd1a9b44a2a7ac3238')).toBe(true)
    for (const bad of ['', 'nothex', '0aa8', `${'a'.repeat(65)}`, "1' OR '1'='1", null, 12])
      expect(isVisitorId(bad)).toBe(false)
  })

  test('the label is the start of the hash, never a name', () => {
    expect(visitorLabel('0aa8b328fdde66fd1a9b44a2a7ac3238')).toBe('#0aa8b3')
    expect(placeLabel('US', 'US-CA:Santa Monica')).toContain('Santa Monica, CA')
    expect(placeLabel(null, null)).toBe('Unknown location')
    const now = new Date('2026-09-25T12:00:00Z')
    expect(timeAgo('2026-09-25T11:59:30Z', now)).toBe('just now')
    expect(timeAgo('2026-09-25T09:00:00Z', now)).toBe('3h ago')
    expect(timeAgo('2026-09-20T12:00:00Z', now)).toBe('5d ago')
  })

  test('the timeline selects no network or browser identifiers', () => {
    // There are none to select, and this keeps it that way.
    const src = read('app/Analytics/visitors.ts').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    for (const col of ['ip', 'user_agent', 'email', 'name AS person'])
      expect(src).not.toMatch(new RegExp(`\\b${col}\\b`))
  })

  test('the migration changes nothing until an owner opts in', () => {
    const sql = read('database/migrations/0000000057-add-visitor-window.sql')
    expect(sql).toContain('"visitor_window_days" integer NOT NULL DEFAULT 1')
    expect(sql).toContain('CHECK ("visitor_window_days" BETWEEN 1 AND 30)')
  })
})
