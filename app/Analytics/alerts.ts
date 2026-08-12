/**
 * Deciding when traffic is worth interrupting someone about (#24).
 *
 * ## The baseline is the whole problem
 *
 * The obvious way to detect a spike — compare this hour against the hour before —
 * does not work on web traffic, because traffic has a shape. 09:00 is reliably
 * busier than 08:00 and 03:00 is reliably dead, so a naive comparison reports a
 * spike every morning and a collapse every night, on every site, forever. An
 * alert that fires daily for a reason the reader already understands is one they
 * will mute, and a muted alert is worse than none: it is still costing sends and
 * no longer carries information.
 *
 * So the baseline is the *same clock window on previous days*. 14:00–15:00 today
 * is judged against 14:00–15:00 on each of the last `baseline_days` days, which
 * holds the daily cycle still and lets a genuine change show.
 *
 * The summary is a **median**, not a mean. One freak day in the sample — a launch,
 * a scraper, an outage — drags a mean far enough to hide the next week's real
 * movement behind it. The median ignores it.
 *
 * ## Small numbers lie
 *
 * Percentage change on tiny counts is noise wearing a suit: three visitors where
 * there was one is +200%. `min_volume` is the floor below which a percentage is
 * not worth believing, and which side it applies to depends on the direction:
 *
 *   - a **spike** must have the floor cleared by the *observed* count, or every
 *     quiet site alerts the moment two people arrive
 *   - a **drop** must have it cleared by the *baseline*, or every quiet site
 *     alerts the moment its usual two people do not
 *
 * Applying it to the wrong side is the difference between an alert that catches
 * an outage and an alert that fires all night on a hobby blog.
 *
 * ## Split
 *
 * Everything that decides is pure and takes numbers. Everything that queries is
 * separate and returns numbers. That is deliberate: the decision logic is where
 * the subtle errors live, and it is testable exactly and without a database.
 */

import { db } from '@stacksjs/database'

export type AlertMetric = 'views' | 'visitors' | 'sessions' | 'conversions'
export type AlertCondition = 'spike' | 'drop' | 'above' | 'below'

export const ALERT_METRICS: readonly AlertMetric[] = ['views', 'visitors', 'sessions', 'conversions'] as const
export const ALERT_CONDITIONS: readonly AlertCondition[] = ['spike', 'drop', 'above', 'below'] as const

/** Conditions measured against a baseline rather than a fixed number. */
export const RELATIVE_CONDITIONS: readonly AlertCondition[] = ['spike', 'drop'] as const

export function isAlertMetric(v: unknown): v is AlertMetric {
  return typeof v === 'string' && (ALERT_METRICS as readonly string[]).includes(v)
}

export function isAlertCondition(v: unknown): v is AlertCondition {
  return typeof v === 'string' && (ALERT_CONDITIONS as readonly string[]).includes(v)
}

export function isRelative(condition: AlertCondition): boolean {
  return (RELATIVE_CONDITIONS as readonly string[]).includes(condition)
}

/** One row of `site_alerts`, as the database hands it back. */
export interface AlertRow {
  id: string
  site_id: string
  name: string
  metric: string
  goal_id: string | null
  condition: string
  threshold: number
  window_minutes: number
  baseline_days: number
  min_volume: number
  cooldown_minutes: number
  channels: string
  is_active: boolean
  last_fired_at: string | null
}

export interface Evaluation {
  fires: boolean
  /** Plain-language account of the decision, for the log and the notification. */
  reason: string
  observed: number
  /** Null for absolute conditions, which have no baseline by definition. */
  baseline: number | null
  /** Null when there is no baseline, or when it is zero and division is undefined. */
  changePct: number | null
}

/**
 * Middle value, averaging the two middles for an even count.
 *
 * Returns 0 for an empty sample so a site with no history is treated as "nothing
 * previously", which is what it is.
 */
export function median(values: number[]): number {
  if (!values.length)
    return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/** Percentage change from `baseline` to `observed`, or null when undefined. */
export function changePercent(observed: number, baseline: number): number | null {
  if (!baseline)
    return null
  return Math.round(((observed - baseline) / baseline) * 100)
}

/**
 * Should this alert fire, given what was observed and what is normal?
 *
 * Pure. `baseline` is ignored for absolute conditions and required for relative
 * ones. The returned `reason` explains the decision either way, because "did not
 * fire" is the answer that gets questioned and it needs to say why.
 */
export function evaluate(
  alert: Pick<AlertRow, 'condition' | 'threshold' | 'min_volume'>,
  observed: number,
  baseline: number | null,
): Evaluation {
  const condition = alert.condition as AlertCondition
  const threshold = Number(alert.threshold)
  const floor = Number(alert.min_volume)

  if (condition === 'above') {
    return {
      fires: observed > threshold,
      reason: `${observed} vs threshold ${threshold}`,
      observed,
      baseline: null,
      changePct: null,
    }
  }

  if (condition === 'below') {
    return {
      fires: observed < threshold,
      reason: `${observed} vs threshold ${threshold}`,
      observed,
      baseline: null,
      changePct: null,
    }
  }

  const base = baseline ?? 0
  const pct = changePercent(observed, base)

  if (condition === 'spike') {
    // The observed side carries the floor: a spike is only a spike if the new
    // number is big enough to mean something on its own.
    if (observed < floor) {
      return { fires: false, reason: `${observed} is below the ${floor} minimum volume`, observed, baseline: base, changePct: pct }
    }
    // No history at all, but real traffic now. Genuinely newsworthy, and the only
    // case where a null percentage still fires.
    if (base === 0) {
      return { fires: true, reason: `${observed} where the usual is none`, observed, baseline: 0, changePct: null }
    }
    return {
      fires: (pct ?? 0) >= threshold,
      reason: `${observed} vs usual ${base} (${pct}%, threshold +${threshold}%)`,
      observed,
      baseline: base,
      changePct: pct,
    }
  }

  // drop. The baseline carries the floor: falling from two visitors to zero is
  // not an outage, it is a Tuesday on a small site.
  if (base < floor) {
    return { fires: false, reason: `usual ${base} is below the ${floor} minimum volume`, observed, baseline: base, changePct: pct }
  }
  return {
    fires: (pct ?? 0) <= -threshold,
    reason: `${observed} vs usual ${base} (${pct}%, threshold -${threshold}%)`,
    observed,
    baseline: base,
    changePct: pct,
  }
}

/**
 * Is this alert still inside its quiet period?
 *
 * A condition that stays true does not stay newsworthy — traffic up 300% at
 * 14:00 is usually still up at 15:00. Without this, one event produces an alert
 * every hour until it resolves.
 */
export function inCooldown(alert: Pick<AlertRow, 'cooldown_minutes' | 'last_fired_at'>, now: Date): boolean {
  if (!alert.last_fired_at)
    return false
  const last = Date.parse(alert.last_fired_at)
  if (!Number.isFinite(last))
    return false
  return now.getTime() - last < Number(alert.cooldown_minutes) * 60_000
}

/** The window one observation covers, ending now. */
export function observationWindow(windowMinutes: number, now: Date): { from: Date, to: Date } {
  return { from: new Date(now.getTime() - windowMinutes * 60_000), to: now }
}

/**
 * The same clock window on each of the previous `days` days.
 *
 * Shifting by whole days rather than re-deriving from a calendar keeps this
 * correct across month ends, and means each sample sits at the same point in the
 * daily traffic cycle as the observation.
 */
export function baselineWindows(windowMinutes: number, days: number, now: Date): Array<{ from: Date, to: Date }> {
  const day = 24 * 60 * 60_000
  const windows = []
  for (let i = 1; i <= days; i++) {
    const to = new Date(now.getTime() - i * day)
    windows.push({ from: new Date(to.getTime() - windowMinutes * 60_000), to })
  }
  return windows
}

/**
 * Count one metric over one window.
 *
 * `metric` selects a literal expression and table — it is never interpolated from
 * caller input, only matched against the union, so an unrecognised value counts
 * nothing rather than reaching the query. `timestamp` is a varchar holding
 * ISO-8601, so the range comparison is lexical, which is correct for that format
 * precisely because it sorts as text.
 */
export async function metricCount(
  siteId: string,
  metric: AlertMetric,
  goalId: string | null,
  from: Date,
  to: Date,
): Promise<number> {
  const fromIso = from.toISOString()
  const toIso = to.toISOString()

  let sql: string
  const params: unknown[] = [siteId, fromIso, toIso]

  if (metric === 'conversions') {
    sql = `SELECT COUNT(*) AS n FROM conversions WHERE site_id = $1 AND timestamp >= $2 AND timestamp <= $3`
    if (goalId) {
      sql += ` AND goal_id = $4`
      params.push(goalId)
    }
  }
  else {
    const expression = metric === 'views'
      ? 'COUNT(*)'
      : metric === 'visitors'
        ? 'COUNT(DISTINCT visitor_id)'
        : 'COUNT(DISTINCT session_id)'
    sql = `SELECT ${expression} AS n FROM page_views WHERE site_id = $1 AND timestamp >= $2 AND timestamp <= $3`
  }

  const rows = await db.unsafe(sql, params).catch(() => []) as Array<{ n: string }>
  return Number(rows?.[0]?.n ?? 0)
}

/**
 * Observe an alert: what is happening now, and what normally happens.
 *
 * Baseline samples are fetched in parallel — each is a narrow indexed range scan
 * on (site_id, timestamp), so a week of them costs one round trip's latency
 * rather than seven. Absolute conditions skip the baseline entirely instead of
 * computing one they will not consult.
 */
export async function observe(alert: AlertRow, now: Date): Promise<{ observed: number, baseline: number | null }> {
  const metric = isAlertMetric(alert.metric) ? alert.metric : 'views'
  const condition = alert.condition as AlertCondition
  const { from, to } = observationWindow(Number(alert.window_minutes), now)

  const observed = await metricCount(alert.site_id, metric, alert.goal_id, from, to)

  if (!isRelative(condition))
    return { observed, baseline: null }

  const samples = await Promise.all(
    baselineWindows(Number(alert.window_minutes), Number(alert.baseline_days), now)
      .map(w => metricCount(alert.site_id, metric, alert.goal_id, w.from, w.to)),
  )

  return { observed, baseline: median(samples) }
}
