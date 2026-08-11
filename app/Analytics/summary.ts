/**
 * The numbers a digest email reports (#14).
 *
 * ## Why this is its own module
 *
 * `routes/analytics.ts` computes the same KPIs inline, per endpoint, against the
 * request's query window. That is the API's shape and it is fine there, but a
 * scheduled job has no request — so reaching for those handlers would mean
 * fabricating one. This computes the same figures from a plain site id and a date
 * range, which is what both a job and, eventually, the API want.
 *
 * The KPI query is deliberately identical to `GET /api/sites/{siteId}/stats`:
 *
 *   COUNT(*) views, COUNT(DISTINCT visitor_id) visitors, COUNT(DISTINCT session_id) sessions
 *   FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?
 *
 * If those two ever disagree the email is lying about the dashboard, which is
 * worse than either being wrong alone. Unifying them properly means giving the
 * route handlers a request-free core to call; that is follow-up work, and this
 * file is the half that has to exist first.
 *
 * `timestamp` is a varchar holding an ISO-8601 string, so the range comparison is
 * lexical — correct for that format precisely because ISO-8601 sorts as text, and
 * the reason every caller passes `toISOString()` rather than a Date.
 */

import { db } from '@stacksjs/database'

export interface DigestKpis {
  views: number
  visitors: number
  sessions: number
}

export interface DigestRow {
  label: string
  views: number
}

export interface SiteSummary {
  siteId: string
  from: string
  to: string
  current: DigestKpis
  /** The equally-long window immediately before `from`, for deltas. */
  previous: DigestKpis
  topPages: DigestRow[]
  topSources: DigestRow[]
  /** True when the period recorded nothing at all — callers skip sending. */
  empty: boolean
}

async function kpis(siteId: string, from: string, to: string): Promise<DigestKpis> {
  const rows = await db.unsafe(
    `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT session_id) AS sessions
     FROM page_views WHERE site_id = $1 AND timestamp >= $2 AND timestamp <= $3`,
    [siteId, from, to],
  ) as Array<{ views: string, visitors: string, sessions: string }>
  const r = rows?.[0]
  return {
    views: Number(r?.views ?? 0),
    visitors: Number(r?.visitors ?? 0),
    sessions: Number(r?.sessions ?? 0),
  }
}

async function topBy(column: 'path' | 'referrer_source', siteId: string, from: string, to: string, limit: number): Promise<DigestRow[]> {
  // Column is a union, not a parameter — it is interpolated into the SQL, so it
  // must never come from a caller's input. Both values are literals here.
  const rows = await db.unsafe(
    `SELECT ${column} AS label, COUNT(*) AS views
     FROM page_views
     WHERE site_id = $1 AND timestamp >= $2 AND timestamp <= $3 AND ${column} IS NOT NULL AND ${column} <> ''
     GROUP BY ${column} ORDER BY views DESC LIMIT ${limit}`,
    [siteId, from, to],
  ) as Array<{ label: string, views: string }>
  return (rows ?? []).map(r => ({ label: String(r.label), views: Number(r.views ?? 0) }))
}

/**
 * Everything one digest needs, for one site, over one window.
 *
 * The previous window is the same length ending where this one starts, so a
 * weekly digest compares against the week before rather than a calendar month or
 * a fixed multiplier. A period with no page views returns `empty: true` and the
 * caller sends nothing — an email reporting zeroes to someone whose site is
 * simply new is a good way to be marked as spam.
 */
export async function siteSummary(siteId: string, from: Date, to: Date): Promise<SiteSummary> {
  const span = to.getTime() - from.getTime()
  const prevFrom = new Date(from.getTime() - span)

  const fromIso = from.toISOString()
  const toIso = to.toISOString()

  const [current, previous, topPages, topSources] = await Promise.all([
    kpis(siteId, fromIso, toIso),
    kpis(siteId, prevFrom.toISOString(), fromIso),
    topBy('path', siteId, fromIso, toIso, 5),
    topBy('referrer_source', siteId, fromIso, toIso, 5),
  ])

  return {
    siteId,
    from: fromIso,
    to: toIso,
    current,
    previous,
    topPages,
    topSources,
    empty: current.views === 0,
  }
}

/**
 * Percentage change, or null when there is no baseline to compare against.
 *
 * Null rather than 0 or Infinity: "first week, nothing to compare" and "flat
 * against last week" are different things, and a template that renders them the
 * same tells the reader something untrue.
 */
export function delta(current: number, previous: number): number | null {
  if (!previous)
    return null
  return Math.round(((current - previous) / previous) * 100)
}
