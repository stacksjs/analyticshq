/**
 * The one statement that deletes expired visitor salts.
 *
 * Dependency-free on purpose. It is run from two places, the app
 * (`purgeExpiredSalts` in ./salt.ts) and the daily prune job
 * (`scripts/analytics/prune.ts`), and the prune job talks to Postgres directly
 * because the framework's database client hangs outside a full app boot. One
 * statement, so the two cannot disagree about when a salt expires.
 *
 * A salt is kept for its window plus `saltRetentionDays - 1` days. For a 1-day
 * window that is today and yesterday. For a site on a 30-day window it is the
 * whole block, plus one day for events that arrive just after it rolls over.
 * The window is read from the salt's site as it is now, so a site that turned
 * visitor timelines off loses its long salt on the next run. A salt whose site
 * is gone is treated as 1-day.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export function purgeSaltsQuery(now: Date, saltRetentionDays: number, maxWindowDays: number): { sql: string, params: [string, number] } {
  const dailyCutoff = new Date(now.getTime() - saltRetentionDays * DAY_MS).toISOString().slice(0, 10)
  return {
    sql: `DELETE FROM visitor_salts vs
     WHERE vs.salt_date < to_char(
       ($1::date) - (LEAST(GREATEST(COALESCE((SELECT s.visitor_window_days FROM sites s WHERE s.id = vs.site_id), 1), 1), $2::int) - 1),
       'YYYY-MM-DD')`,
    params: [dailyCutoff, Math.max(1, maxWindowDays)],
  }
}
