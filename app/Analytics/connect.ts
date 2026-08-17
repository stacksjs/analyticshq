/**
 * The BI connector surface — the Looker Studio half of #25.
 *
 * ## Why a dedicated endpoint rather than opening up the Stats API
 *
 * The Stats API is a dozen differently-shaped endpoints behind
 * `.middleware('auth')`, which 401s before a handler runs. Teaching all of them
 * to accept a share token would mean loosening the auth on every site-scoped
 * route at once — including the ones that change settings, add members and
 * delete data — and relying on each call site's role check to hold the line.
 * That is a large blast radius for a reporting feature.
 *
 * This is one route, unauthenticated by middleware and gated on a share token it
 * validates itself, that can only ever read. It cannot reach an endpoint that
 * writes because it is not one.
 *
 * It also suits the consumer better. A BI tool wants ONE flat table it can
 * group and pivot, not ten endpoints with ten shapes.
 *
 * ## Why the share token rather than a new API key
 *
 * A share token is already a long-lived, per-site, read-only credential that an
 * admin can rotate or revoke (POST/DELETE /api/sites/{id}/share). A BI tool
 * needs exactly that. Minting a second kind of credential with the same powers
 * and a separate revocation path would mean an operator who revokes sharing
 * still has a live key they have to remember to find.
 *
 * ## Field selection is closed, not a query language
 *
 * Dimensions and metrics are looked up in the tables below and anything absent
 * is refused. The alternative — accepting a column name and interpolating it —
 * is SQL injection with extra steps, and it would also expose columns that are
 * deliberately not reportable.
 *
 * NOTHING VISITOR-LEVEL IS EXPOSED. `visitor_id` and `session_id` are not
 * dimensions and cannot become ones: the whole product argument is that a site
 * owner gets counts, not people, and a BI tool is exactly where a per-visitor
 * export would be most tempting and least visible.
 */

export interface FieldSpec {
  /** The SQL expression, already safe — these are constants, never input. */
  sql: string
  /** Looker Studio's semantic type, so the connector needs no second table. */
  type: 'date' | 'text' | 'number'
}

/**
 * Groupable columns.
 *
 * Every one is a column `page_views` already stores and the dashboard already
 * reports on. Adding one here should mean it is reportable, not merely present:
 * `hostname`, `title` and the utm_* columns are omitted deliberately for now
 * rather than by oversight, since each widens the row count a connector pulls.
 */
export const CONNECT_DIMENSIONS: Record<string, FieldSpec> = {
  // YYYY-MM-DD. Timestamps are ISO strings, so the first 10 characters are the
  // UTC date — the same SUBSTRING grouping every other daily report uses,
  // rather than a cast that would forfeit the index.
  date: { sql: `SUBSTRING(timestamp FROM 1 FOR 10)`, type: 'date' },
  path: { sql: `path`, type: 'text' },
  referrer_source: { sql: `referrer_source`, type: 'text' },
  country: { sql: `country`, type: 'text' },
  device_type: { sql: `device_type`, type: 'text' },
  browser: { sql: `browser`, type: 'text' },
  os: { sql: `os`, type: 'text' },
  utm_campaign: { sql: `utm_campaign`, type: 'text' },
}

/**
 * Aggregates.
 *
 * `visitors` counts DISTINCT visitor_id, which is the pseudonymous rotating
 * hash — a count, never the value. The hash itself is not exposed as a
 * dimension and must not become one.
 */
export const CONNECT_METRICS: Record<string, FieldSpec> = {
  views: { sql: `COUNT(*)`, type: 'number' },
  visitors: { sql: `COUNT(DISTINCT visitor_id)`, type: 'number' },
  sessions: { sql: `COUNT(DISTINCT session_id)`, type: 'number' },
  bounces: { sql: `COUNT(*) FILTER (WHERE is_bounce)`, type: 'number' },
}

/** Fields a caller may never group by, whatever else is added above. */
export const CONNECT_FORBIDDEN_DIMENSIONS = ['visitor_id', 'session_id', 'id', 'referrer', 'screen_width', 'screen_height'] as const

export interface ConnectRequest {
  dimensions: string[]
  metrics: string[]
}

export type ConnectPlan =
  | { error: string }
  | { dimensions: string[], metrics: string[], sql: string, groupBy: number[] }

/** Rows one request may return. A BI tool paginates by narrowing its range. */
export const CONNECT_MAX_ROWS = 100_000

/**
 * Parse a comma-separated field list, preserving order and dropping blanks.
 *
 * Order matters: the response is positional, so the request's order is the
 * column order and the connector reads it back by index.
 */
export function parseFieldList(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * Build the query for a requested field set, or explain the refusal.
 *
 * Refusals name the offending field and list what is available. A BI connector
 * failure surfaces to the user as an opaque "could not fetch data", so the
 * message is the only diagnostic anyone gets.
 */
export function planQuery(req: ConnectRequest): ConnectPlan {
  const dimensions = [...new Set(req.dimensions)]
  const metrics = [...new Set(req.metrics)]

  if (metrics.length === 0)
    return { error: `at least one metric is required. Available: ${Object.keys(CONNECT_METRICS).join(', ')}` }

  for (const d of dimensions) {
    if (!CONNECT_DIMENSIONS[d]) {
      return {
        error: (CONNECT_FORBIDDEN_DIMENSIONS as readonly string[]).includes(d)
          // Named explicitly. "unknown dimension: visitor_id" invites someone to
          // conclude it is a spelling problem and go looking for the right name.
          ? `${d} is not reportable: it identifies a visit rather than describing one, and this endpoint returns counts, not people.`
          : `unknown dimension: ${d}. Available: ${Object.keys(CONNECT_DIMENSIONS).join(', ')}`,
      }
    }
  }
  for (const m of metrics) {
    if (!CONNECT_METRICS[m])
      return { error: `unknown metric: ${m}. Available: ${Object.keys(CONNECT_METRICS).join(', ')}` }
  }

  const selects = [
    ...dimensions.map(d => `${CONNECT_DIMENSIONS[d].sql} AS "${d}"`),
    ...metrics.map(m => `${CONNECT_METRICS[m].sql} AS "${m}"`),
  ]
  // GROUP BY ordinals rather than repeating the expressions: the date dimension
  // is a SUBSTRING, and a copy of it in two places is a copy that can diverge.
  const groupBy = dimensions.map((_, i) => i + 1)

  const sql = `SELECT ${selects.join(', ')}
     FROM page_views
     WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?${dimensions.length ? `
     GROUP BY ${groupBy.join(', ')}` : ''}
     ORDER BY ${metrics.length ? `${metrics.length + dimensions.length} DESC` : '1'}
     LIMIT ${CONNECT_MAX_ROWS}`

  return { dimensions, metrics, sql, groupBy }
}

/**
 * Shape one database row into the positional array the connector expects.
 *
 * Nulls become empty strings for text and 0 for numbers. Looker Studio renders a
 * null text dimension as a blank row that cannot be filtered out, and a null
 * metric breaks its aggregation entirely.
 */
export function shapeRow(row: Record<string, unknown>, dimensions: string[], metrics: string[]): Array<string | number> {
  return [
    ...dimensions.map((d) => {
      const v = row[d]
      return v === null || v === undefined ? '' : String(v)
    }),
    ...metrics.map((m) => {
      const v = Number(row[m])
      return Number.isFinite(v) ? v : 0
    }),
  ]
}

/** The schema a BI tool asks for before it asks for data. */
export function describeFields(): Array<{ name: string, kind: 'dimension' | 'metric', type: string }> {
  return [
    ...Object.entries(CONNECT_DIMENSIONS).map(([name, spec]) => ({ name, kind: 'dimension' as const, type: spec.type })),
    ...Object.entries(CONNECT_METRICS).map(([name, spec]) => ({ name, kind: 'metric' as const, type: spec.type })),
  ]
}

/**
 * Constant-time-ish comparison for the share token.
 *
 * Not a defence against a serious timing attack — the token is 128 bits of
 * hex and guessing it is not the threat — but a plain `===` on a secret is a
 * habit worth not having in a file that gates data access.
 */
export type ShareVerdict = { ok: true } | { ok: false, status: 401 | 403 | 404, error: string }

/**
 * The whole access decision for a connector request, as a pure function.
 *
 * Extracted from the route deliberately. A source-level test that the handler
 * "mentions tokenMatches" passes just as well when the branch has been changed
 * to `if (false)` — which is exactly the mutation that turns this endpoint into
 * an open data export, and exactly the one that survived when this logic lived
 * inline. Every branch is now reachable by calling something.
 *
 * The order is deliberate and matches the rest of the API: a missing credential
 * is 401 before anything is looked up, an unknown site is 404, and a site that
 * exists but will not answer you is 403. Site ids are public — they ship in the
 * tracking snippet — so telling 404 from 403 leaks nothing.
 */
export function shareTokenVerdict(provided: string, expected: string, siteExists: boolean): ShareVerdict {
  if (!provided)
    return { ok: false, status: 401, error: 'A share token is required. Create one in the dashboard under Share, then paste it into the connector.' }
  if (!siteExists)
    return { ok: false, status: 404, error: 'Site not found' }
  if (!expected)
    return { ok: false, status: 403, error: 'Sharing is not enabled for this site. Enable it in the dashboard under Share.' }
  if (!tokenMatches(provided, expected))
    return { ok: false, status: 403, error: 'That share token is not valid for this site. It may have been rotated or revoked.' }
  return { ok: true }
}

export function tokenMatches(provided: string, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string')
    return false
  if (provided.length !== expected.length || expected.length === 0)
    return false
  let diff = 0
  for (let i = 0; i < provided.length; i++)
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}
