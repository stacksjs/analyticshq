/**
 * Retention purge — delete analytics rows older than the retention window.
 *
 *   ANALYTICSHQ_RETENTION_DAYS=395 bun scripts/analytics/prune.ts [--dry-run]
 *
 * Scheduled to run daily (see app/Scheduler.ts). With `ANALYTICSHQ_RETENTION_DAYS`
 * unset or 0, retention is DISABLED and nothing is deleted — data is kept
 * indefinitely until an operator opts in to a window. Visitor rows are already
 * pseudonymous (24h-rotating hash, no stored IP), so this is data-minimisation,
 * not erasure of personal data. See issue #4.
 *
 * Timestamps are stored as ISO-8601 varchars, which sort lexicographically, so a
 * plain `"<column>" < cutoff` compare selects exactly the expired rows.
 */
import { connect, log, parseArgs, retentionCutoff, retentionDays } from './lib'

// Each visitor-level table with the column that dates its rows.
const TABLES: [table: string, column: string][] = [
  ['page_views', 'timestamp'],
  ['sessions', 'started_at'],
  ['custom_events', 'timestamp'],
  ['conversions', 'timestamp'],
  // One row per metric per page view, so this is the highest-volume table here
  // and the one retention matters most for (#41).
  ['web_vitals', 'timestamp'],
]

const args = parseArgs()
const dryRun = args['dry-run'] === true
const days = retentionDays()
const cutoff = retentionCutoff(days)

if (!cutoff) {
  log('[retention] ANALYTICSHQ_RETENTION_DAYS unset or 0 — retention disabled, nothing pruned.')
  process.exit(0)
}

const sql = connect()
log(`[retention] keeping ${days} days; ${dryRun ? 'would delete' : 'deleting'} rows older than ${cutoff}`)

let total = 0
for (const [table, column] of TABLES) {
  let n = 0
  if (dryRun) {
    const rows = await sql.unsafe(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE "${column}" < $1`, [cutoff])
    n = rows[0]?.n ?? 0
  }
  else {
    const res = await sql.unsafe(`DELETE FROM "${table}" WHERE "${column}" < $1 RETURNING 1`, [cutoff])
    n = Array.isArray(res) ? res.length : (res?.count ?? 0)
  }
  total += n
  log(`[retention] ${dryRun ? 'would delete' : 'deleted'} ${n} from ${table}`)
}

log(`[retention] ${dryRun ? 'would delete' : 'deleted'} ${total} rows total`)
await sql.end()
