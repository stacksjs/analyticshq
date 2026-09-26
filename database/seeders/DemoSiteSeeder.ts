/**
 * The public demo site (app/Analytics/demo.ts), kept a year deep and current.
 *
 *   ./buddy seed --only-seeders DemoSiteSeeder --skip-models
 *
 * app/Scheduler.ts runs exactly that every hour, so the demo's "today" fills in
 * through the day and its year never goes stale. --skip-models matters: no model
 * here declares useSeeder today, and the flag keeps it that way on production
 * if one ever does.
 *
 * Every write goes through the models, so each row gets the same mass
 * assignment, validation and timestamps as any other write. createMany sends
 * one multi-row INSERT per few thousand records (bun-query-builder 0.3), which
 * is what makes a year of traffic practical to write this way.
 *
 * WHAT A RUN REBUILDS
 *
 * The generator is deterministic per day, so a day built twice is identical.
 * A run therefore deletes and rebuilds only from the last day it wrote (at least
 * the last three, for Search Console's two-day lag) through today, and drops
 * what has aged out of the year. A change to the generator bumps DEMO_VERSION,
 * and a version mismatch rebuilds the whole year once.
 */
import { Seeder } from '@stacksjs/database'
import { buildDemoDay, DEMO_DAYS, DEMO_GOALS, DEMO_HOSTNAME, DEMO_SHARE_TOKEN, DEMO_SITE_ID, DEMO_VERSION, demoDayStart } from '../../app/Analytics/demo'
import Conversion from '../../app/Models/Conversion'
import CustomEvent from '../../app/Models/CustomEvent'
import Goal from '../../app/Models/Goal'
import PageView from '../../app/Models/PageView'
import SearchQuery from '../../app/Models/SearchQuery'
import Session from '../../app/Models/Session'
import Site from '../../app/Models/Site'
import WebVital from '../../app/Models/WebVital'

function parseSettings(raw: unknown): Record<string, unknown> {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

export default class DemoSiteSeeder extends Seeder {
  static override tags = ['demo'] as const

  async run(): Promise<void> {
    const now = new Date()

    const existing = await Site.find(DEMO_SITE_ID)
    const settings = parseSettings(existing?.settings)
    const full = settings.demo_version !== DEMO_VERSION

    // Where to rebuild from, in days before today.
    let from = DEMO_DAYS - 1
    if (!full) {
      const latest = await PageView.where('site_id', DEMO_SITE_ID).orderByDesc('timestamp').first()
      if (latest?.timestamp) {
        const lastDay = new Date(`${String(latest.timestamp).slice(0, 10)}T00:00:00Z`).getTime()
        const agoOfLast = Math.round((demoDayStart(now, 0).getTime() - lastDay) / 864e5)
        from = Math.min(DEMO_DAYS - 1, Math.max(2, agoOfLast))
      }
    }

    // The site first: every table below references it. No owner and no
    // members, so it is in nobody's site switcher; the share token in every
    // demo link is the only way in.
    //
    // demo_version is recorded only once the traffic is written (below). A
    // run that dies halfway must leave the next one rebuilding the year, not
    // mistaking a partial year for a finished one.
    const kept = { ...settings }
    delete kept.demo_version
    await Site.updateOrCreate({ id: DEMO_SITE_ID }, {
      name: DEMO_HOSTNAME,
      domains: JSON.stringify([`https://${DEMO_HOSTNAME}`]),
      timezone: 'UTC',
      currency: 'USD',
      is_active: true,
      settings: JSON.stringify({ ...kept, share_token: DEMO_SHARE_TOKEN, ...(full ? {} : { demo_version: DEMO_VERSION }) }),
    })
    for (const { id, ...goal } of DEMO_GOALS)
      await Goal.updateOrCreate({ id }, { ...goal, site_id: DEMO_SITE_ID, is_active: true })

    // Drop the days being rebuilt, and whatever has aged out of the year.
    // Children before parents: conversions, page views and events reference
    // sessions.
    const since = demoDayStart(now, from).toISOString()
    const floor = demoDayStart(now, DEMO_DAYS - 1).toISOString()
    for (const [operator, stamp] of [['>=', since], ['<', floor]] as const) {
      await Conversion.where('site_id', DEMO_SITE_ID).where('timestamp', operator, stamp).delete()
      await CustomEvent.where('site_id', DEMO_SITE_ID).where('timestamp', operator, stamp).delete()
      await PageView.where('site_id', DEMO_SITE_ID).where('timestamp', operator, stamp).delete()
      await WebVital.where('site_id', DEMO_SITE_ID).where('timestamp', operator, stamp).delete()
      // Search Console rows are dated by day, not by instant.
      await SearchQuery.where('site_id', DEMO_SITE_ID).where('date', operator, stamp.slice(0, 10)).delete()
      await Session.where('site_id', DEMO_SITE_ID).where('started_at', operator, stamp).delete()
    }

    // A day at a time, parents before children, so the seeder never holds
    // more than a day of rows. The statements themselves are bounded by
    // bun-query-builder 0.3.2: createMany writes power-of-two batches of at
    // most 4096 parameters. Before that, a year of variously sized batches
    // was over a thousand distinct statements, each cached as a prepared
    // statement on the connection, and the Postgres backend holding them grew
    // past a gigabyte. On production it shares a cgroup capped at 512MB with
    // every other app's database, and it stalled all of them.
    for (let ago = from; ago >= 0; ago--) {
      const day = buildDemoDay(now, ago)
      await Session.createMany(day.sessions)
      await PageView.createMany(day.pageViews)
      await CustomEvent.createMany(day.events)
      await Conversion.createMany(day.conversions)
      await WebVital.createMany(day.vitals)
      await SearchQuery.createMany(day.searchQueries)
    }

    if (full) {
      await Site.updateOrCreate({ id: DEMO_SITE_ID }, {
        settings: JSON.stringify({ ...kept, share_token: DEMO_SHARE_TOKEN, demo_version: DEMO_VERSION }),
      })
    }
  }
}
