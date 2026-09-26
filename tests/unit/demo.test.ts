/**
 * The public demo (app/Analytics/demo.ts, database/seeders/DemoSiteSeeder.ts).
 *
 * Every "Live demo" link used to open /dashboard, which a signed-out visitor
 * sees as a sign-in wall. They now open a read-only share link to a demo site
 * whose traffic is generated here and refreshed hourly.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildDemoDay, DEMO_DASHBOARD_PATH, DEMO_DAYS, DEMO_GOALS, DEMO_SHARE_TOKEN, DEMO_SITE_ID } from '../../app/Analytics/demo'
import { parseUserAgent, referrerSource } from '../../app/Analytics/tracking'

const root = join(import.meta.dir, '../..')
const now = new Date('2026-09-26T15:30:00Z')

describe('the generator', () => {
  test('builds the same day twice, byte for byte', () => {
    // The hourly refresh rebuilds recent days. If a rebuild drew different
    // rows, the demo's history would shift under a reader comparing periods.
    expect(JSON.stringify(buildDemoDay(now, 9))).toBe(JSON.stringify(buildDemoDay(now, 9)))
  })

  test('today stops at now, and no day spills past its own midnight', () => {
    const today = buildDemoDay(now, 0)
    expect(today.pageViews.length).toBeGreaterThan(0)
    for (const pv of today.pageViews)
      expect(String(pv.timestamp) <= now.toISOString()).toBe(true)

    // The seeder deletes a rebuilt day from its start. A session running past
    // midnight would leave its tail in the next day, orphaned by that delete.
    const day = buildDemoDay(now, 5)
    const date = String(day.sessions[0]!.started_at).slice(0, 10)
    for (const row of [...day.pageViews, ...day.events, ...day.conversions, ...day.vitals])
      expect(String(row.timestamp).slice(0, 10)).toBe(date)
  })

  test('a year of traffic, with a visible trend', () => {
    const old = buildDemoDay(now, DEMO_DAYS - 20).pageViews.length
    const recent = buildDemoDay(now, 20).pageViews.length
    expect(recent).toBeGreaterThan(old)
  })

  test('labels are the ones real ingest writes', () => {
    // Referrer sources and device labels come from the /collect parsers, fed
    // real URLs and User-Agents, so the demo cannot drift from real rows.
    const day = buildDemoDay(now, 12)
    const sources = new Set(day.pageViews.map(p => p.referrer_source))
    for (const label of ['Google', 'Direct', 'GitHub'])
      expect(sources.has(label)).toBe(true)
    expect(referrerSource('https://news.ycombinator.com/item')).toBe('Hacker News')

    const browsers = new Set(day.pageViews.map(p => p.browser))
    expect(browsers.has(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36').browser)).toBe(true)
  })

  test('one conversion per session per goal, as /collect records them', () => {
    const day = buildDemoDay(now, 30)
    const keys = day.conversions.map(c => `${c.session_id}|${c.goal_id}`)
    expect(new Set(keys).size).toBe(keys.length)
    const goals = new Set(DEMO_GOALS.map(g => g.id))
    for (const c of day.conversions)
      expect(goals.has(String(c.goal_id))).toBe(true)
  })

  test('every row belongs to the demo site', () => {
    const day = buildDemoDay(now, 3)
    for (const row of [...day.sessions, ...day.pageViews, ...day.events, ...day.conversions, ...day.vitals, ...day.searchQueries])
      expect(row.site_id).toBe(DEMO_SITE_ID)
  })
})

describe('the demo link', () => {
  test('is a share link the dashboard will accept', () => {
    expect(DEMO_SHARE_TOKEN).toMatch(/^[0-9a-f]{32}$/)
    expect(DEMO_DASHBOARD_PATH).toBe(`/dashboard?site=${DEMO_SITE_ID}&share=${DEMO_SHARE_TOKEN}`)
  })

  test('every demo call to action opens it', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory())
          walk(path)
        else if (/\.(stx|ts)$/.test(name))
          files.push(path)
      }
    }
    walk(join(root, 'resources'))

    let links = 0
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/to="([^"]*)"[^>]*>\s*(See a live dashboard|Live demo)/g)) {
        links++
        expect({ file, to: m[1] }).toEqual({ file, to: DEMO_DASHBOARD_PATH })
      }
    }
    expect(links).toBeGreaterThan(20)
    expect(readFileSync(join(root, 'resources/data/competitors.ts'), 'utf8')).toContain('to: DEMO_DASHBOARD_PATH')
  })

  test('a run that dies halfway is rebuilt, not mistaken for done', () => {
    // The first production run was stopped partway, after the old seeder had
    // already recorded demo_version, so the next run would have treated a
    // partial year as complete. The version is now written after the rows.
    const seeder = readFileSync(join(root, 'database/seeders/DemoSiteSeeder.ts'), 'utf8')
    const code = seeder.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const lastWrite = code.lastIndexOf('SearchQuery.createMany')
    const versionWrite = code.indexOf('demo_version: DEMO_VERSION')
    expect(lastWrite).toBeGreaterThan(-1)
    // Only recorded up front when it is already true, i.e. on an incremental run.
    expect(code).toContain('...(full ? {} : { demo_version: DEMO_VERSION })')
    expect(code.lastIndexOf('demo_version: DEMO_VERSION')).toBeGreaterThan(lastWrite)
    expect(versionWrite).toBeGreaterThan(-1)
  })

  test('the scheduler keeps it current', () => {
    const scheduler = readFileSync(join(root, 'app/Scheduler.ts'), 'utf8')
    expect(scheduler).toContain('seed --only-seeders DemoSiteSeeder --skip-models')
  })
})
