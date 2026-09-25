/**
 * Visitor timelines: the visitors a site saw, and everything one of them did.
 *
 * ## Only for sites that asked for it
 *
 * A visitor id is a hash with a secret salt (./salt.ts). On a site that never
 * opted in the salt changes every UTC day, so a "visitor" is one person on one
 * day, and a per-person view would be a timeline that can never be more than a
 * day long. So these reports exist only once the site's owner has turned on
 * "Remember returning visitors", which keeps one salt for a fixed block of up
 * to 30 days (`sites.visitor_window_days`). `timelinesEnabled` is the gate and
 * every caller checks it.
 *
 * ## What it never becomes
 *
 * Pseudonymous, per site, and bounded. The id is a hash nobody can reverse once
 * the block's salt is deleted, it is different on every other site, and it
 * cannot outlive its block. There is no name, email, IP or user agent anywhere
 * in this data, and there is no `identify()`. A timeline shows what the
 * aggregate reports already hold (pages, sources, coarse location, device),
 * grouped by the id instead of summed over it.
 *
 * ## Why a module and not route code
 *
 * GET /api/sites/{id}/visitors and the /visitor page both read these, for the
 * same reason the site list is one function in ./access.ts: two copies of a
 * query answer the same question two ways.
 */

import { db } from '@stacksjs/database'

/** Visitors per list, newest activity first. */
export const VISITOR_LIST_LIMIT = 50

/** Row caps for one timeline. A block is at most 30 days of one person. */
const TIMELINE_LIMITS = { sessions: 300, pageviews: 2000, events: 1000, conversions: 500 }

/** Visitor ids are 32 hex characters. Anything else cannot match a row. */
export function isVisitorId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{16,64}$/.test(value)
}

/** A `?`-placeholder query, as the filter builder writes them, in Postgres `$n` form. */
function toPg(sql: string): string {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

function pgTrue(raw: unknown): boolean {
  return raw === true || raw === 't' || raw === 1
}

/** The site's window in days, or 1 when the site or the column is missing. */
export async function visitorWindowDays(siteId: string): Promise<number> {
  const rows = await db.unsafe(`SELECT visitor_window_days FROM sites WHERE id = $1 LIMIT 1`, [String(siteId)])
    .catch(() => []) as Array<{ visitor_window_days: unknown }>
  const n = Number(rows?.[0]?.visitor_window_days)
  return Number.isInteger(n) && n >= 1 ? n : 1
}

/** Whether this site keeps visitor ids across days. Fails closed. */
export async function timelinesEnabled(siteId: string): Promise<boolean> {
  return (await visitorWindowDays(siteId)) > 1
}

export interface VisitorSummary {
  visitor_id: string
  first_seen: string
  last_seen: string
  pageviews: number
  visits: number
  days: number
  country: string | null
  city: string | null
  device: string | null
  browser: string | null
  first_source: string | null
}

/**
 * The visitors seen in a range, most recent first. `filterSql` is the report
 * filter fragment (`AND country = ?`), so clicking a country and then opening
 * the visitor list shows the visitors from that country.
 */
export async function listVisitors(siteId: string, from: string, to: string, filterSql = '', filterParams: unknown[] = [], limit = VISITOR_LIST_LIMIT): Promise<VisitorSummary[]> {
  const rows = await db.unsafe(toPg(
    `SELECT visitor_id,
            MIN(timestamp) AS first_seen,
            MAX(timestamp) AS last_seen,
            COUNT(*) AS pageviews,
            COUNT(DISTINCT session_id) AS visits,
            COUNT(DISTINCT SUBSTRING(timestamp FROM 1 FOR 10)) AS days,
            (array_agg(country ORDER BY timestamp DESC) FILTER (WHERE country IS NOT NULL))[1] AS country,
            (array_agg(city ORDER BY timestamp DESC) FILTER (WHERE city IS NOT NULL))[1] AS city,
            (array_agg(device_type ORDER BY timestamp DESC) FILTER (WHERE device_type IS NOT NULL))[1] AS device,
            (array_agg(browser ORDER BY timestamp DESC) FILTER (WHERE browser IS NOT NULL))[1] AS browser,
            (array_agg(referrer_source ORDER BY timestamp ASC))[1] AS first_source
     FROM page_views
     WHERE site_id = ? AND timestamp >= ? AND timestamp <= ? AND visitor_id ~ '^[a-f0-9]{16,64}$'${filterSql}
     GROUP BY visitor_id
     ORDER BY MAX(timestamp) DESC
     LIMIT ?`,
  ), [String(siteId), from, to, ...filterParams, Math.max(1, Math.min(200, limit))]) as any[]

  return (rows ?? []).map(r => ({
    visitor_id: String(r.visitor_id),
    first_seen: String(r.first_seen),
    last_seen: String(r.last_seen),
    pageviews: Number(r.pageviews),
    visits: Number(r.visits),
    days: Number(r.days),
    country: r.country ?? null,
    city: r.city ?? null,
    device: r.device ?? null,
    browser: r.browser ?? null,
    first_source: r.first_source ?? null,
  }))
}

export type TimelineItem =
  | { kind: 'pageview', at: string, path: string }
  | { kind: 'event', at: string, name: string, path: string | null, properties: string | null }
  | { kind: 'conversion', at: string, goal: string | null, path: string | null, amount_minor: number | null, currency: string | null }

export interface TimelineVisit {
  session_id: string
  started_at: string
  ended_at: string | null
  duration: number
  entry_path: string | null
  exit_path: string | null
  source: string | null
  referrer: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  country: string | null
  region: string | null
  city: string | null
  device: string | null
  browser: string | null
  os: string | null
  bounce: boolean
  items: TimelineItem[]
}

export interface VisitorTimeline {
  visitor_id: string
  first_seen: string | null
  last_seen: string | null
  days: number
  totals: { visits: number, pageviews: number, events: number, conversions: number, revenue_minor: number }
  visits: TimelineVisit[]
}

/**
 * Everything one visitor did on one site, grouped into visits, oldest first.
 * Returns null when the id has no rows here, which the caller answers as 404.
 */
export async function visitorTimeline(siteId: string, visitorId: string): Promise<VisitorTimeline | null> {
  if (!isVisitorId(visitorId))
    return null
  const args = [String(siteId), visitorId]

  const [sessions, pageviews, events, conversions] = await Promise.all([
    db.unsafe(
      `SELECT id, started_at, ended_at, duration, entry_path, exit_path, referrer_source, referrer,
              utm_source, utm_medium, utm_campaign, country, region, city, device_type, browser, os, is_bounce
       FROM sessions WHERE site_id = $1 AND visitor_id = $2 ORDER BY started_at ASC LIMIT ${TIMELINE_LIMITS.sessions}`,
      args,
    ),
    db.unsafe(
      `SELECT session_id, timestamp, path, referrer_source, country, region, city, device_type, browser, os
       FROM page_views WHERE site_id = $1 AND visitor_id = $2 ORDER BY timestamp ASC LIMIT ${TIMELINE_LIMITS.pageviews}`,
      args,
    ),
    db.unsafe(
      `SELECT session_id, timestamp, name, path, properties
       FROM custom_events WHERE site_id = $1 AND visitor_id = $2 ORDER BY timestamp ASC LIMIT ${TIMELINE_LIMITS.events}`,
      args,
    ),
    db.unsafe(
      `SELECT c.session_id, c.timestamp, c.path, c.amount_minor, c.currency, g.name AS goal
       FROM conversions c LEFT JOIN goals g ON g.id = c.goal_id
       WHERE c.site_id = $1 AND c.visitor_id = $2 ORDER BY c.timestamp ASC LIMIT ${TIMELINE_LIMITS.conversions}`,
      args,
    ),
  ]) as [any[], any[], any[], any[]]

  if (!sessions?.length && !pageviews?.length)
    return null

  const visits = new Map<string, TimelineVisit>()
  for (const s of sessions ?? []) {
    visits.set(String(s.id), {
      session_id: String(s.id),
      started_at: String(s.started_at),
      ended_at: s.ended_at ?? null,
      duration: Number(s.duration ?? 0),
      entry_path: s.entry_path ?? null,
      exit_path: s.exit_path ?? null,
      source: s.referrer_source ?? null,
      referrer: s.referrer ?? null,
      utm_source: s.utm_source ?? null,
      utm_medium: s.utm_medium ?? null,
      utm_campaign: s.utm_campaign ?? null,
      country: s.country ?? null,
      region: s.region ?? null,
      city: s.city ?? null,
      device: s.device_type ?? null,
      browser: s.browser ?? null,
      os: s.os ?? null,
      bounce: pgTrue(s.is_bounce),
      items: [],
    })
  }

  // A page view whose session row is missing (pruned, or written before the
  // session was) still belongs on the timeline. It gets a visit of its own,
  // built from the page view's columns.
  const visitFor = (sessionId: unknown, at: string, pv?: any): TimelineVisit => {
    const key = String(sessionId ?? `orphan:${at.slice(0, 10)}`)
    let visit = visits.get(key)
    if (!visit) {
      visit = {
        session_id: key,
        started_at: at,
        ended_at: null,
        duration: 0,
        entry_path: pv?.path ?? null,
        exit_path: null,
        source: pv?.referrer_source ?? null,
        referrer: null,
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        country: pv?.country ?? null,
        region: pv?.region ?? null,
        city: pv?.city ?? null,
        device: pv?.device_type ?? null,
        browser: pv?.browser ?? null,
        os: pv?.os ?? null,
        bounce: false,
        items: [],
      }
      visits.set(key, visit)
    }
    return visit
  }

  for (const p of pageviews ?? [])
    visitFor(p.session_id, String(p.timestamp), p).items.push({ kind: 'pageview', at: String(p.timestamp), path: String(p.path ?? '/') })
  for (const e of events ?? [])
    visitFor(e.session_id, String(e.timestamp)).items.push({ kind: 'event', at: String(e.timestamp), name: String(e.name), path: e.path ?? null, properties: e.properties ?? null })
  let revenue = 0
  for (const c of conversions ?? []) {
    const amount = c.amount_minor == null ? null : Number(c.amount_minor)
    if (amount)
      revenue += amount
    visitFor(c.session_id, String(c.timestamp)).items.push({ kind: 'conversion', at: String(c.timestamp), goal: c.goal ?? null, path: c.path ?? null, amount_minor: amount, currency: c.currency ?? null })
  }

  const ordered = [...visits.values()].sort((a, b) => a.started_at.localeCompare(b.started_at))
  for (const v of ordered)
    v.items.sort((a, b) => a.at.localeCompare(b.at))

  const stamps = ordered.flatMap(v => [v.started_at, ...v.items.map(i => i.at)]).filter(Boolean).sort()
  const days = new Set(stamps.map(s => s.slice(0, 10))).size

  return {
    visitor_id: visitorId,
    first_seen: stamps[0] ?? null,
    last_seen: stamps[stamps.length - 1] ?? null,
    days,
    totals: {
      visits: ordered.length,
      pageviews: (pageviews ?? []).length,
      events: (events ?? []).length,
      conversions: (conversions ?? []).length,
      revenue_minor: revenue,
    },
    visits: ordered,
  }
}
