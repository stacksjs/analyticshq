/**
 * Google Analytics import — the normalization and synthesis both importers share.
 *
 * There are two ways history arrives: a CSV a human exported from GA4
 * (`scripts/analytics/import-ga.ts`) and the GA4 Data API
 * (`scripts/analytics/import-ga4.ts` and the dashboard flow). They must produce
 * the SAME rows for the same property, so the mapping and the synthesis live
 * here rather than once in each — two spellings of "what a GA row becomes" would
 * be free to disagree, and disagreements between two importers surface as a
 * customer's numbers changing depending on which path they used.
 *
 * ## What synthesis means, and its limits
 *
 * GA4 exports AGGREGATES. Individual pageviews are not recoverable, and no
 * importer can invent them. What this does is manufacture page_views and
 * sessions rows that REPRODUCE the daily totals, so imported history flows
 * through the same dashboard queries as native data instead of needing a second
 * read path everywhere.
 *
 * The rows are therefore synthetic and say so: ids carry `gap_`/`gas_` prefixes,
 * which is what lets `--replace` remove a prior GA import without touching real
 * traffic (or a Fathom import). Timestamps within a day are spread evenly rather
 * than being real arrival times — a fabricated hour-of-day distribution would be
 * a claim we cannot support, and this one is at least obviously uniform.
 */
import { createHash } from 'node:crypto'
import { normCountry } from './country'

/** One GA row, already normalized — whatever produced it. */
export interface GaRecord {
  /** YYYY-MM-DD */
  date: string
  path: string
  source: string
  medium: string | null
  campaign: string | null
  /** ISO-3166 alpha-2, or null when GA gave a name we cannot map. */
  country: string | null
  device: string
  browser: string
  os: string
  pageviews: number
  sessions: number
  users: number
}

// --- normalization ---------------------------------------------------------

/** GA4 dates come as YYYYMMDD or YYYY-MM-DD; normalize to YYYY-MM-DD. */
export function normDate(v: string): string {
  const s = (v || '').trim()
  if (/^\d{8}$/.test(s))
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  return s.slice(0, 10)
}

export function toInt(v: unknown): number {
  return Math.max(0, Number.parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0)
}

export function clip(v: string, n: number): string {
  return v.length > n ? v.slice(0, n) : v
}

const OS_MAP: Record<string, string> = { 'Mac OS X': 'macOS', 'Mac OS': 'macOS', 'Macintosh': 'macOS', 'OS X': 'macOS' }
export const normDevice = (v: string): string => (v || '').toLowerCase() || 'unknown'
export const normOs = (v: string): string => OS_MAP[v] || v || 'Unknown'

/**
 * GA4's "country" dimension is the full English name; `page_views.country` is a
 * varchar(2) ISO code.
 *
 * The mapping moved to `./country` when the live ingest path turned out to need
 * exactly the same coercion — it normalized here, for backfilled rows, and not
 * at `/collect`, so the column's invariant held for imported history and not for
 * real traffic. Imported *and* re-exported: `toRecord` below calls it, and
 * existing callers import it from this module.
 */
export { normCountry }

/** GA spells "no referrer" several ways; they all mean Direct. */
export function normSource(v: string): string {
  const s = (v || '').trim()
  return !s || /^\(direct\)$|^\(none\)$|^direct$/i.test(s) ? 'Direct' : s
}

/**
 * Build a record from already-split values. Shared so the CSV and API paths
 * cannot drift on, say, what an empty source means.
 */
export function toRecord(raw: {
  date: string
  path?: string
  source?: string
  medium?: string
  campaign?: string
  country?: string
  device?: string
  browser?: string
  os?: string
  pageviews?: unknown
  sessions?: unknown
  users?: unknown
  /** True when the caller had no pageviews column and sessions must stand in. */
  pageviewsMissing?: boolean
  sessionsMissing?: boolean
  usersMissing?: boolean
}): GaRecord | null {
  const date = normDate(raw.date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return null

  const pageviews = raw.pageviewsMissing ? toInt(raw.sessions) : toInt(raw.pageviews)
  if (pageviews <= 0)
    return null

  // Sessions cannot exceed pageviews (a session has at least one view) and
  // cannot be zero when there are views. Users cannot exceed sessions. Clamping
  // rather than trusting: GA's numbers come from different sampling passes and
  // genuinely disagree at the margins, and an unclamped pair produces a negative
  // per-session view count and a divide-by-zero downstream.
  const sessions = raw.sessionsMissing
    ? Math.max(1, Math.round(pageviews / 2))
    : Math.min(Math.max(toInt(raw.sessions), 1), pageviews)
  const users = raw.usersMissing
    ? sessions
    : Math.min(Math.max(toInt(raw.users), 1), sessions)

  return {
    date,
    path: clip(raw.path || '/', 255),
    source: raw.source || '',
    medium: raw.medium ? clip(raw.medium, 64) : null,
    campaign: raw.campaign ? clip(raw.campaign, 128) : null,
    country: normCountry(raw.country || ''),
    device: clip(normDevice(raw.device || ''), 16),
    browser: clip(raw.browser || 'Unknown', 32),
    os: clip(normOs(raw.os || ''), 32),
    pageviews,
    sessions,
    users,
  }
}

// --- synthesis -------------------------------------------------------------

/**
 * Deterministic short hex hash, for stable synthetic ids.
 *
 * Identical to `scripts/analytics/lib.ts:shortHash` (sha256, hex, first 12) —
 * the sync spelling, so synthesis needs no await. Re-importing the same export
 * therefore rewrites the same ids rather than doubling the traffic.
 */
export function rowKey(input: string, len = 12): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len)
}

export interface SynthesizedRows {
  sessions: Record<string, unknown>[]
  pageViews: Record<string, unknown>[]
}

/** Seconds of a day the synthetic sessions are spread across (leaves the tail quiet). */
const DAY_SPAN = 86400 * 0.92
/** Assumed gap between consecutive views in a synthesized session. */
const VIEW_GAP_SECONDS = 45

function isoStamp(d: Date): string {
  return d.toISOString().replace(/(\.\d{3})Z$/, '$1Z')
}

/**
 * Turn one aggregate record into the page_views + sessions rows that reproduce it.
 *
 * The distribution is deliberate and worth stating, because it is visible in the
 * dashboard: `pageviews` views are dealt round-robin across `sessions` sessions,
 * so the counts differ by at most one. Sessions holding exactly one view are
 * marked as bounces, which is how the bounce rate for imported history arises —
 * it is a consequence of GA's own sessions/views ratio, not a number we invented
 * separately.
 *
 * `users` is honoured by reusing visitor ids across sessions (`j % users`), so a
 * day with 10 sessions from 4 users reports 4 unique visitors.
 */
export function synthesizeRecord(siteId: string, rec: GaRecord, now: Date = new Date()): SynthesizedRows {
  const out: SynthesizedRows = { sessions: [], pageViews: [] }
  const day = new Date(`${rec.date}T00:00:00Z`)
  const referrerSource = clip(normSource(rec.source), 128)
  const utmSource = rec.source ? clip(rec.source, 255) : null
  // `rec.source || 'Direct'` rather than the raw source, and rather than
  // `referrerSource`. Both alternatives are defensible and both would be wrong:
  // this reproduces the key the CSV importer used before the synthesis moved
  // here, so a site that has already imported gets the same ids on a re-import
  // and ON CONFLICT DO NOTHING makes it the no-op it should be. Changing this
  // string silently doubles the history of anyone who re-imports without
  // --replace, which is not a failure they would see until the numbers were
  // already wrong.
  const key = rowKey(`${siteId}|${rec.date}|${rec.path}|${rec.source || 'Direct'}|${rec.country}|${rec.device}|${rec.browser}|${rec.os}`)

  const counts = Array.from({ length: rec.sessions }, () => 0)
  for (let k = 0; k < rec.pageviews; k++)
    counts[k % rec.sessions]++

  for (let j = 0; j < rec.sessions; j++) {
    const visitor = `gap_${key}_${j % rec.users}`
    const views = counts[j]
    const bounce = views === 1
    const start = new Date(day.getTime() + Math.floor((j / Math.max(rec.sessions, 1)) * DAY_SPAN) * 1000)
    const sessionId = `gas_${key}_${j}`

    out.sessions.push({
      id: sessionId,
      site_id: siteId,
      visitor_id: visitor,
      entry_path: rec.path,
      referrer: '',
      referrer_source: referrerSource,
      utm_source: utmSource,
      utm_medium: rec.medium,
      utm_campaign: rec.campaign,
      country: rec.country,
      device_type: rec.device,
      browser: rec.browser,
      os: rec.os,
      page_view_count: views,
      is_bounce: bounce,
      duration: views > 1 ? (views - 1) * VIEW_GAP_SECONDS : 0,
      started_at: isoStamp(start),
      created_at: now,
      updated_at: now,
    })

    for (let m = 0; m < views; m++) {
      out.pageViews.push({
        id: `gap_${key}_${j}_${m}`,
        site_id: siteId,
        session_id: sessionId,
        visitor_id: visitor,
        path: rec.path,
        hostname: null,
        referrer: '',
        referrer_source: referrerSource,
        utm_source: utmSource,
        utm_medium: rec.medium,
        utm_campaign: rec.campaign,
        country: rec.country,
        device_type: rec.device,
        browser: rec.browser,
        os: rec.os,
        // The session's first view counts as unique only while we still have
        // distinct users left to attribute it to.
        is_unique: m === 0 && j < rec.users,
        is_bounce: bounce,
        time_on_page: m < views - 1 ? VIEW_GAP_SECONDS : 0,
        timestamp: isoStamp(new Date(start.getTime() + m * VIEW_GAP_SECONDS * 1000)),
        created_at: now,
        updated_at: now,
      })
    }
  }
  return out
}

// --- writing --------------------------------------------------------------

/**
 * Columns written for each table, in one place.
 *
 * The CLI talks to Postgres through Bun.SQL and the HTTP endpoint through the
 * framework's `db`, so they cannot share an executor — but they must not drift
 * on which columns get written or in what order. `buildInsert` gives both the
 * same statement and lets each run it its own way.
 */
export const SESSION_COLUMNS = [
  'id', 'site_id', 'visitor_id', 'entry_path', 'referrer', 'referrer_source',
  'utm_source', 'utm_medium', 'utm_campaign', 'country', 'device_type', 'browser',
  'os', 'page_view_count', 'is_bounce', 'duration', 'started_at', 'created_at', 'updated_at',
] as const

export const PAGE_VIEW_COLUMNS = [
  'id', 'site_id', 'session_id', 'visitor_id', 'path', 'hostname', 'referrer',
  'referrer_source', 'utm_source', 'utm_medium', 'utm_campaign', 'country',
  'device_type', 'browser', 'os', 'is_unique', 'is_bounce', 'time_on_page',
  'timestamp', 'created_at', 'updated_at',
] as const

/**
 * A multi-row INSERT with `$n` placeholders, plus its flat parameter list.
 *
 * ON CONFLICT DO NOTHING because synthetic ids are deterministic: re-running an
 * import over a range already imported must be a no-op, not a primary-key error
 * that aborts halfway and leaves the site holding half a history.
 */
export function buildInsert(
  table: 'sessions' | 'page_views',
  rows: Record<string, unknown>[],
): { sql: string, params: unknown[] } | null {
  if (!rows.length)
    return null
  const columns = table === 'sessions' ? SESSION_COLUMNS : PAGE_VIEW_COLUMNS
  const placeholders: string[] = []
  const params: unknown[] = []
  let n = 0
  for (const row of rows) {
    placeholders.push(`(${columns.map(() => `$${++n}`).join(', ')})`)
    for (const c of columns)
      params.push(row[c] ?? null)
  }
  return {
    sql: `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES ${placeholders.join(', ')} ON CONFLICT (id) DO NOTHING`,
    params,
  }
}

/** Ids of rows a GA import created, for `--replace` to remove. */
export const GA_PAGE_VIEW_PREFIX = 'gap_'
export const GA_SESSION_PREFIX = 'gas_'

// --- CSV ------------------------------------------------------------------

/** Quote-aware split of a single CSV line. */
export function splitCsv(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else q = false
      }
      else { cur += c }
    }
    else if (c === '"') { q = true }
    else if (c === ',') { out.push(cur); cur = '' }
    else { cur += c }
  }
  out.push(cur)
  return out
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Our field → the GA4 column names it may appear under (normalized). */
export const CSV_ALIASES: Record<string, string[]> = {
  date: ['date', 'yearmonthday', 'isodate'],
  path: ['pagepath', 'pagepathandscreenclass', 'pagepathplusquerystring', 'pagepathscreenclass', 'landingpage'],
  source: ['sessionsource', 'firstusersource', 'sessionsourcemedium', 'source', 'sessiondefaultchannelgroup'],
  medium: ['sessionmedium', 'medium'],
  campaign: ['sessioncampaign', 'sessioncampaignname', 'campaign'],
  country: ['countryid', 'countryisocode', 'countrycode', 'country'],
  device: ['devicecategory', 'device'],
  browser: ['browser'],
  os: ['operatingsystem', 'os'],
  pageviews: ['screenpageviews', 'views', 'pageviews'],
  sessions: ['sessions'],
  users: ['totalusers', 'activeusers', 'users'],
}

/** Resolve field → column index from the header row. */
export function resolveColumns(header: string[]): Record<string, number> {
  const normed = header.map(norm)
  const idx: Record<string, number> = {}
  for (const [field, names] of Object.entries(CSV_ALIASES)) {
    const i = normed.findIndex(h => names.includes(h))
    if (i !== -1)
      idx[field] = i
  }
  return idx
}
