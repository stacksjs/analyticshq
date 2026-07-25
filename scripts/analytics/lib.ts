/**
 * Shared helpers for the analytics import/export CLI tools.
 *
 * These run OUTSIDE the Stacks framework boot, where `@stacksjs/database` hangs
 * on connection init. So they talk to Postgres directly via Bun's built-in SQL
 * client, driven purely by env vars (with local-dev defaults). analyticshq is
 * Postgres-only, so no dialect abstraction is needed.
 */

/** Open a Bun.SQL connection from env (or DATABASE_URL), with local-dev defaults. */
export function connect(): Bun.SQL {
  const url = process.env.DATABASE_URL
    || `postgres://${process.env.DB_USERNAME || process.env.USER || 'postgres'}`
    + `:${process.env.DB_PASSWORD || ''}`
    + `@${process.env.DB_HOST || '127.0.0.1'}`
    + `:${process.env.DB_PORT || 5432}`
    + `/${process.env.DB_DATABASE || 'analyticshq'}`
  return new Bun.SQL(url)
}

export type Args = Record<string, string | boolean>

/** Parse `--flag=value` / `--flag` argv into a map. */
export function parseArgs(argv: string[] = Bun.argv.slice(2)): Args {
  const out: Args = {}
  for (const a of argv) {
    if (!a.startsWith('--'))
      continue
    const eq = a.indexOf('=')
    if (eq === -1)
      out[a.slice(2)] = true
    else
      out[a.slice(2, eq)] = a.slice(eq + 1)
  }
  return out
}

/** Read a required string flag or exit with a usage error. */
export function requireArg(args: Args, name: string, usage?: string): string {
  const v = args[name]
  if (typeof v !== 'string' || v === '') {
    process.stderr.write(`error: missing required --${name}\n${usage ? `${usage}\n` : ''}`)
    process.exit(1)
  }
  return v
}

/** Log to stderr so stdout stays clean for piped data (e.g. NDJSON export). */
export function log(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

/** Deterministic short hex hash — for stable synthetic ids. */
export async function shortHash(input: string, len = 12): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, len)
}

/** ISO string analyticshq stores in the varchar `timestamp`/`started_at` cols. */
export function isoStamp(d: Date): string {
  return d.toISOString().replace(/(\.\d{3})Z$/, '$1Z')
}

/**
 * Days of analytics history to keep, from `ANALYTICSHQ_RETENTION_DAYS`. A positive
 * integer enables retention; unset, 0, or invalid means disabled (keep forever).
 */
export function retentionDays(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.ANALYTICSHQ_RETENTION_DAYS ?? 0)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

/**
 * ISO cutoff for the retention window: rows whose (ISO, lexically-sortable)
 * timestamp is strictly older than this are eligible for pruning. Returns null
 * when retention is disabled (`days <= 0`).
 */
export function retentionCutoff(days: number, now: Date = new Date()): string | null {
  if (!(days > 0))
    return null
  return isoStamp(new Date(now.getTime() - days * 86_400_000))
}

/**
 * The current N-day window and the immediately-preceding N-day window, as ISO
 * bounds — for a digest that reports a period and its change vs. the one before.
 */
export function periodWindows(days: number, now: Date = new Date()): {
  curFrom: string
  curTo: string
  prevFrom: string
  prevTo: string
} {
  const span = days * 86_400_000
  const to = now
  const from = new Date(to.getTime() - span)
  const prevFrom = new Date(from.getTime() - span)
  return { curFrom: isoStamp(from), curTo: isoStamp(to), prevFrom: isoStamp(prevFrom), prevTo: isoStamp(from) }
}

/** Percent change from `prev` to `cur`, rounded; null when there's no baseline. */
export function pctChange(cur: number, prev: number): number | null {
  if (!prev)
    return null
  return Math.round(((cur - prev) / prev) * 100)
}

/** Verify a analyticshq site exists; exit if not. Returns its row. */
export async function requireSite(sql: Bun.SQL, siteId: string): Promise<{ id: string, name: string, owner_id: number | null }> {
  const rows = await sql`SELECT id, name, owner_id FROM sites WHERE id = ${siteId} LIMIT 1`
  if (!rows.length) {
    log(`error: no site "${siteId}" in this database. Create it first (dashboard "Add site" or POST /api/sites).`)
    process.exit(1)
  }
  return rows[0]
}
