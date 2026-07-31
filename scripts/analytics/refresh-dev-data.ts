/**
 * Refresh stale dev data — slide the analytics rows already in the database
 * forward so the newest event lands inside the last 24 hours.
 *
 *   bun scripts/analytics/refresh-dev-data.ts --dry-run
 *   bun scripts/analytics/refresh-dev-data.ts --yes
 *   bun scripts/analytics/refresh-dev-data.ts --yes --anchor=global
 *
 * Seed data ages out from under you: the dashboard's 24h / 7d / 30d presets go
 * empty while the 1y default still has rows, so a perfectly healthy app looks
 * broken during manual testing. This fabricates NOTHING — it only UPDATEs the
 * timestamps of rows that already exist, so every count, join and cardinality
 * in the database is byte-for-byte what it was before.
 *
 * The delta is a whole number of DAYS and is applied to `page_views`,
 * `sessions`, `conversions` and `custom_events` in one transaction, so a
 * session and its page views / conversions / events stay aligned. Whole days
 * also preserve hour-of-day (the hourly chart keeps its shape) and the exact
 * relative spacing between every pair of rows.
 *
 * Only the EVENT columns are shifted. `created_at` / `updated_at` are a
 * batch-insert clock, not event time: every row a seeder or an importer wrote
 * shares one value (all 195 Fathom-imported page views here carry the single
 * instant the import ran), so it says nothing about when the traffic happened.
 * Adding the event delta to it is actively wrong — the Fathom batch, whose
 * events are five years older than its `created_at`, landed in 2031-12-01 on
 * the first cut of this script. So the row clock is instead REBASED onto the
 * row's own shifted event instant, which is what it would have held had the
 * traffic been tracked live; `updated_at` keeps its original offset from
 * `created_at`, and stays NULL where it was NULL.
 *
 * `--anchor=site` (the default) gives each site its own delta, because a single
 * database-wide delta cannot fix the reported symptom: sites here are seeded
 * days-to-years apart, so anchoring on the newest event ANYWHERE leaves the
 * older sites exactly as invisible as they were. Sites never join to each
 * other — every visitor table carries `site_id`, and `sessions` belong to one
 * site — so a per-site delta is join-safe. `--anchor=global` keeps the whole
 * database on one delta when you'd rather preserve cross-site timing.
 *
 * Like the other scripts here it talks to Postgres directly via Bun's built-in
 * SQL client, because `@stacksjs/database` hangs on connection init outside a
 * full framework boot.
 *
 * Safety: this is a blind destructive UPDATE across every visitor table, so it
 * refuses to run unless the effective DB host is loopback, and it never writes
 * without an explicit `--yes`. It is safe to re-run: the delta is re-derived
 * from the data on every run, so a second run straight after the first computes
 * 0 days and does nothing.
 */
import { connect, isoStamp, log, parseArgs } from './lib'

/** The canonical shape analyticshq writes into its varchar timestamp columns. */
const ISO_RE = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`

interface TableSpec {
  /** Table name. */
  table: string
  /** ISO-8601 varchar columns that date the EVENT. All are shifted. */
  event: string[]
  /** The non-null event column `created_at`/`updated_at` are rebased onto. */
  anchor: string
}

// Every visitor-level table, in the same order prune.ts lists them.
const TABLES: TableSpec[] = [
  { table: 'page_views', event: ['timestamp'], anchor: 'timestamp' },
  { table: 'sessions', event: ['started_at', 'ended_at'], anchor: 'started_at' },
  { table: 'conversions', event: ['timestamp'], anchor: 'timestamp' },
  { table: 'custom_events', event: ['timestamp'], anchor: 'timestamp' },
]

const USAGE = `usage: refresh-dev-data [--dry-run | --yes] [--anchor=site|global]
  --dry-run          report the exact shift it would apply; write nothing
  --yes              apply it (required — there is no implicit write)
  --anchor=site      default: every site's newest event lands in the last 24h
  --anchor=global    one delta for the whole database, anchored on the newest
                     event anywhere (sites seeded further back stay that far back)`

const args = parseArgs()
const dryRun = args['dry-run'] === true
const confirmed = args.yes === true
const anchor = (args.anchor as string) || 'site'

if (anchor !== 'site' && anchor !== 'global') {
  log(`error: unknown --anchor "${anchor}" (use site or global)\n${USAGE}`)
  process.exit(1)
}
if (!dryRun && !confirmed) {
  log(`error: refusing to rewrite every analytics timestamp without --yes.\n${USAGE}`)
  process.exit(1)
}

/**
 * The host `connect()` will actually dial. DATABASE_URL wins there, so the
 * guard has to read it the same way round or it would be checking a DB_HOST
 * that is never used.
 *
 * Note for anyone testing this guard: in this app `DB_HOST=… bun scripts/…`
 * does NOT reach here. The `@stacksjs/env/plugin.js` bunfig preload overwrites
 * process.env from `.env`, so the shell value is discarded. That is safe — the
 * guard and `connect()` read the same clobbered value, so the host it reports
 * is always the host it dials — but it means the only way to point this script
 * elsewhere is `.env` itself or DATABASE_URL (which `.env` does not set).
 */
export function effectiveHost(env: Record<string, string | undefined> = process.env): string {
  if (env.DATABASE_URL) {
    try {
      return new URL(env.DATABASE_URL).hostname
    }
    catch {
      return env.DATABASE_URL // unparseable: fail the loopback check loudly
    }
  }
  return env.DB_HOST || '127.0.0.1'
}

/** Loopback only — the whole 127/8 block, plus ::1 and localhost. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/**
 * Whole days to add so `newest` lands in the last 24 hours without going into
 * the future. Flooring is what makes the shift a whole number of days (keeping
 * hour-of-day intact) and what makes a re-run a no-op.
 */
export function deltaDays(newest: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - newest.getTime()) / 86_400_000)
}

const host = effectiveHost()
if (!isLoopback(host)) {
  log(`error: refusing to run against non-loopback database host "${host}".`)
  log('       This rewrites every analytics timestamp in place — dev only.')
  process.exit(1)
}

const sql = connect()
const now = new Date()
const mode = dryRun ? 'dry run (no writes)' : 'APPLYING'
log(`[refresh] ${mode} · db host ${host} (loopback) · anchor ${anchor} · now ${isoStamp(now)}`)

// --- preflight -------------------------------------------------------------
// The shift rewrites the date portion of the ISO varchars by string surgery,
// which is exact and timezone-free — but only for the canonical `…Z` form. Any
// other shape (bare local time, an offset like +08:00) would be silently
// mangled, so refuse to touch the database at all if one exists.
let malformed = 0
for (const { table, event } of TABLES) {
  for (const col of event) {
    const [r] = await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "${col}" IS NOT NULL AND "${col}" !~ $1`,
      [ISO_RE],
    )
    if (r?.n) {
      malformed += r.n
      log(`[refresh] error: ${r.n} row(s) in ${table}.${col} are not canonical ISO-8601 ("…T…Z")`)
    }
  }
}
if (malformed) {
  log('[refresh] aborted — refusing to rewrite timestamps it cannot parse exactly.')
  await sql.end()
  process.exit(1)
}

// --- plan ------------------------------------------------------------------
// Group key: the site id, or a single bucket for the whole database.
const GLOBAL = '*'
const key = (siteId: string | null) => (anchor === 'global' ? GLOBAL : (siteId ?? ''))

interface Group {
  /** Newest event timestamp anywhere in the group, as stored. */
  newest: string
  /** Row count per table. */
  counts: Record<string, number>
  total: number
}

const groups = new Map<string, Group>()
for (const { table, event } of TABLES) {
  // ISO-8601 sorts lexicographically, so max() over the varchar is the newest
  // event without any casting. GREATEST skips NULLs (e.g. sessions.ended_at).
  const newestExpr = event.length === 1 ? `"${event[0]}"` : `GREATEST(${event.map(c => `"${c}"`).join(', ')})`
  const rows: { site_id: string | null, newest: string | null, n: number }[] = await sql.unsafe(
    `SELECT site_id, MAX(${newestExpr}) AS newest, COUNT(*)::int AS n FROM "${table}" GROUP BY site_id`,
  )
  for (const r of rows) {
    const k = key(r.site_id)
    const g = groups.get(k) ?? { newest: '', counts: {}, total: 0 }
    if (r.newest && r.newest > g.newest)
      g.newest = r.newest
    g.counts[table] = (g.counts[table] ?? 0) + r.n
    g.total += r.n
    groups.set(k, g)
  }
}

if (groups.size === 0) {
  log('[refresh] no analytics rows in this database — nothing to shift.')
  await sql.end()
  process.exit(0)
}

// Names purely for readable output.
const names = new Map<string, string>()
for (const s of await sql`SELECT id, name FROM sites`)
  names.set(s.id, s.name ?? '(unnamed)')

const plan: { k: string, label: string, days: number, g: Group }[] = []
for (const [k, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  const label = k === GLOBAL ? 'whole database' : `site ${k} "${names.get(k) ?? '(unknown)'}"`
  plan.push({ k, label, days: deltaDays(new Date(g.newest), now), g })
}

let shiftable = 0
for (const { label, days, g } of plan) {
  const tally = TABLES.map(t => `${t.table} ${g.counts[t.table] ?? 0}`).join(', ')
  if (days <= 0) {
    log(`[refresh] ${label}: newest ${g.newest} is already within 24h — skipping (${g.total} rows untouched)`)
    continue
  }
  const landed = isoStamp(new Date(new Date(g.newest).getTime() + days * 86_400_000))
  const hoursAgo = ((now.getTime() - new Date(landed).getTime()) / 3_600_000).toFixed(1)
  log(`[refresh] ${label}`)
  log(`[refresh]   +${days} day(s): newest ${g.newest} -> ${landed} (${hoursAgo}h ago)`)
  log(`[refresh]   ${g.total} rows: ${tally}`)
  shiftable += g.total
}

if (shiftable === 0) {
  log('[refresh] nothing to do — every group is already current.')
  await sql.end()
  process.exit(0)
}

if (dryRun) {
  log(`[refresh] dry run: would shift ${shiftable} rows across ${plan.filter(p => p.days > 0).length} group(s). Re-run with --yes to apply.`)
  await sql.end()
  process.exit(0)
}

// --- apply -----------------------------------------------------------------
// One transaction for all four tables: a half-applied shift would desynchronise
// sessions from their page views, which is worse than stale data.
let written = 0
await sql.begin(async (tx: Bun.SQL) => {
  for (const { k, days, g } of plan) {
    if (days <= 0)
      continue
    for (const { table, event, anchor } of TABLES) {
      if (!g.counts[table])
        continue
      // Whole-day shift by string surgery on the date portion: the time portion
      // is copied through untouched, so no timezone conversion ever enters.
      const shift = (c: string) => `((SUBSTRING("${c}" FROM 1 FOR 10)::date + $1::int)::text || SUBSTRING("${c}" FROM 11))`
      // The shifted anchor as a local wall-clock timestamp — the same form the
      // tracker writes into created_at. Every SET expression reads the row's
      // OLD values, so the shift has to be re-applied here rather than reusing
      // the column name.
      const rebased = `(${shift(anchor)}::timestamptz AT TIME ZONE current_setting('TimeZone'))`
      const sets = [
        ...event.map(c => `"${c}" = ${shift(c)}`),
        // COALESCE: a NULL anchor must never null out a NOT NULL column.
        `"created_at" = COALESCE(${rebased}, "created_at")`,
        // Preserve the original updated_at − created_at offset, and its NULLs.
        `"updated_at" = COALESCE(${rebased}, "created_at") + ("updated_at" - "created_at")`,
      ]
      const where = k === GLOBAL ? '' : ' WHERE site_id = $2'
      const params = k === GLOBAL ? [days] : [days, k]
      const res = await tx.unsafe(`UPDATE "${table}" SET ${sets.join(', ')}${where}`, params)
      const n = Array.isArray(res) ? res.length : (res?.count ?? 0)
      written += n || (g.counts[table] ?? 0)
    }
  }
})

log(`[refresh] shifted ${written} rows. Re-run --dry-run to confirm it is now a no-op.`)
await sql.end()
