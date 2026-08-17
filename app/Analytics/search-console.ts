/**
 * Search Console API client — the SEO half of #25.
 *
 * Which queries brought people to the site, how often they were shown, and where
 * the page ranked. It is the one thing our own analytics genuinely cannot see:
 * search engines strip the query from the referrer, so without this the whole
 * organic channel is a single row saying "Google".
 *
 * ## No Google dependency, same as the GA4 import
 *
 * #25 was open on the question of whether SEO/BI integrations mean taking a
 * standing dependency on Google — registering an application, a consent screen,
 * verification for a sensitive scope, refresh tokens for customers' Google
 * accounts. They do not. This uses a service account the CUSTOMER creates in
 * their own Cloud project and grants read access to their own property, exactly
 * as app/Analytics/ga4.ts does, sharing the same signer in ./google-auth.
 *
 * We register nothing with Google and hold no long-lived credential.
 *
 * ## What arrives, and what deliberately does not
 *
 * Rows are per day, per query, per page. There is no visitor dimension in the
 * API and none in the table — see the migration for why that means this data
 * sits outside the erasure path rather than being forgotten about.
 *
 * Google also withholds queries made by too few people before we ever see them,
 * reporting them only as a bulk total. That is why an SEO report needs no
 * disclosure floor of its own: the anonymisation already happened upstream, and
 * `anonymized` on the result says how much was withheld so the numbers are never
 * silently short.
 *
 * ## Test seams
 *
 * GOOGLE_TOKEN_URL and SEARCH_CONSOLE_API_BASE let a harness stand in for
 * Google, so signing, pagination and folding run without a network.
 */
import { getAccessToken, SCOPE_SEARCH_CONSOLE_READONLY } from './google-auth'

const API_BASE = (): string => process.env.SEARCH_CONSOLE_API_BASE || 'https://searchconsole.googleapis.com'

/**
 * The scope this importer signs with, exported so a test can assert the value
 * the call site passes rather than grepping for a literal.
 */
export const SEARCH_CONSOLE_SCOPE = SCOPE_SEARCH_CONSOLE_READONLY

/** Rows per request. Google's documented maximum for searchAnalytics.query. */
const ROW_LIMIT = 25_000
/** Hard stop so a large property cannot page forever. Reported when hit. */
const MAX_PAGES = 40

/**
 * The dimensions requested, in order.
 *
 * Positional, because the API returns them in a `keys` array and names them
 * nowhere in the response — so this constant defines both the request and how
 * the reply is read, and the two cannot drift.
 */
export const SEARCH_DIMENSIONS = ['date', 'query', 'page'] as const

export interface SearchConsoleApiRow {
  keys?: string[]
  clicks?: number
  impressions?: number
  ctr?: number
  position?: number
}

export interface SearchQueryRecord {
  date: string
  query: string
  path: string
  clicks: number
  impressions: number
  position: number
}

/**
 * Normalise a Search Console property identifier.
 *
 * Search Console has two property kinds and they are not interchangeable:
 *   - a URL-prefix property, identified by a URL: "https://example.com/"
 *   - a domain property, identified by "sc-domain:example.com"
 *
 * People paste a bare hostname, which is neither, and get a 403 that reads as a
 * permissions problem rather than a formatting one. A bare hostname is
 * therefore resolved to the domain-property form, which is the kind Search
 * Console now creates by default.
 *
 * Returns null rather than guessing when the input is not recognisable.
 */
export function normalizeSiteUrl(raw: string): string | null {
  const value = String(raw ?? '').trim()
  if (!value)
    return null
  if (value.startsWith('sc-domain:')) {
    const host = value.slice('sc-domain:'.length).trim().toLowerCase()
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? `sc-domain:${host}` : null
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      // Search Console stores URL-prefix properties WITH a trailing slash, and
      // the API path must match the property exactly or it 404s.
      return `${url.protocol}//${url.host}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`
    }
    catch {
      return null
    }
  }
  const host = value.toLowerCase().replace(/\/+$/, '')
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? `sc-domain:${host}` : null
}

/**
 * Reduce a result URL to the path stored in `page_views.path`.
 *
 * Search Console reports absolute URLs. Keeping them whole would mean the SEO
 * report and the pages report describe the same page with two different strings,
 * so nothing could be joined and "which of my pages ranks" would need a human to
 * match them up by eye.
 */
export function toPath(pageUrl: string): string {
  const value = String(pageUrl ?? '').trim()
  if (!value)
    return '/'
  try {
    const url = new URL(value)
    return (url.pathname || '/').slice(0, 255)
  }
  catch {
    // Already a path, or something unparseable. Keep a leading slash so it can
    // still line up with page_views.
    return (value.startsWith('/') ? value : `/${value}`).slice(0, 255)
  }
}

/** Whether a row is Google's bulk "anonymized queries" placeholder. */
export function isAnonymizedRow(row: SearchConsoleApiRow): boolean {
  const query = row.keys?.[1] ?? ''
  return query === '' || query.toLowerCase() === 'anonymized query' || query.toLowerCase() === 'anonymized queries'
}

/**
 * Fold API rows into records, dropping the ones that describe nothing storable.
 *
 * Anonymized rows are counted and dropped rather than stored: they are real
 * traffic, but under a placeholder rather than a query, and storing them would
 * put a search term called "anonymized query" at the top of the report.
 */
export function toSearchRecords(rows: SearchConsoleApiRow[]): {
  records: SearchQueryRecord[]
  skipped: number
  anonymized: number
} {
  const records: SearchQueryRecord[] = []
  let skipped = 0
  let anonymized = 0
  for (const row of rows) {
    if (isAnonymizedRow(row)) {
      anonymized++
      continue
    }
    const [date, query, page] = row.keys ?? []
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) {
      skipped++
      continue
    }
    const impressions = Math.max(0, Math.round(Number(row.impressions ?? 0)))
    // A row with no impressions describes nothing that happened.
    if (impressions === 0) {
      skipped++
      continue
    }
    records.push({
      date: String(date),
      query: String(query ?? '').slice(0, 255),
      path: toPath(String(page ?? '')),
      // Clicks cannot exceed impressions: you cannot be clicked more often than
      // you were shown, and an unclamped pair produces a CTR over 100%.
      clicks: Math.min(impressions, Math.max(0, Math.round(Number(row.clicks ?? 0)))),
      impressions,
      position: Number.isFinite(Number(row.position)) ? Number(row.position) : 0,
    })
  }
  return { records, skipped, anonymized }
}

export interface SearchConsoleReport {
  rows: SearchConsoleApiRow[]
  /** True when we stopped paging at MAX_PAGES — the import is partial. */
  truncated: boolean
}

/**
 * Run the query, following pagination.
 *
 * `fetchImpl` is injectable so pagination and error handling are testable
 * against canned responses; this loop is where an off-by-one silently drops the
 * last page of someone's history.
 */
export async function runSearchAnalytics(
  token: string,
  siteUrl: string,
  range: { startDate: string, endDate: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SearchConsoleReport> {
  const rows: SearchConsoleApiRow[] = []
  let truncated = false
  let page = 0

  for (; page < MAX_PAGES; page++) {
    const res = await fetchImpl(
      `${API_BASE()}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: range.startDate,
          endDate: range.endDate,
          dimensions: [...SEARCH_DIMENSIONS],
          rowLimit: ROW_LIMIT,
          startRow: page * ROW_LIMIT,
          // Web results only. Discover and News are separate surfaces with
          // different dimensions, and folding them together would double-count.
          type: 'web',
          // Finalised numbers only. 'all' includes the last few days that Google
          // is still revising, which would import figures that change after the
          // fact and never get corrected.
          dataState: 'final',
        }),
      },
    )
    if (!res.ok) {
      const body = await res.text()
      throw new Error(searchConsoleError(res.status, body, siteUrl))
    }
    const data = await res.json() as { rows?: SearchConsoleApiRow[] }
    const batch = data.rows ?? []
    rows.push(...batch)
    if (batch.length < ROW_LIMIT)
      break
  }
  if (page >= MAX_PAGES)
    truncated = true

  return { rows, truncated }
}

/**
 * Turn Google's refusal into something a person can act on.
 *
 * A 403 here almost always means the service account was never granted access
 * to the property, and Google's own message ("User does not have sufficient
 * permission for site X") sends people to check their own Google account
 * instead of the service account's email. Naming the actual fix is the
 * difference between a two-minute setup and a support ticket.
 */
export function searchConsoleError(status: number, body: string, siteUrl: string): string {
  if (status === 403) {
    return `Search Console refused access to "${siteUrl}" (403). Add the service account's email as a user on that property in Search Console → Settings → Users and permissions. Being an owner of the property yourself is not enough — the service account needs its own access.`
  }
  if (status === 404) {
    return `Search Console has no property "${siteUrl}" (404). The identifier must match the property exactly: a domain property is "sc-domain:example.com", and a URL-prefix property is the full URL including the trailing slash.`
  }
  return `Search Console refused the query (${status}): ${body.slice(0, 300)}`
}

/** Every way an import can be incomplete, in the words the person sees. */
export function searchImportWarnings(state: {
  truncated: boolean
  anonymized: number
  skipped: number
}): string[] {
  const out: string[] = []
  if (state.truncated)
    out.push('This period has more search data than one import can page through, so it is incomplete. Import it in shorter periods.')
  if (state.anonymized > 0) {
    out.push(`Google withheld ${state.anonymized.toLocaleString()} rows whose search terms were made by too few people to report individually. Those impressions and clicks really happened, but the query is not available to anyone — including us — so they are not imported.`)
  }
  if (state.skipped > 0)
    out.push(`${state.skipped.toLocaleString()} rows had no usable date or no impressions and were skipped.`)
  return out
}

export interface SearchConsoleFetchOptions {
  siteUrl: string
  key: Parameters<typeof getAccessToken>[0]
  /** Defaults to Search Console's own retention limit, 16 months. */
  startDate?: string
  endDate?: string
  fetchImpl?: typeof fetch
}

export interface SearchConsoleFetchResult {
  records: SearchQueryRecord[]
  rowCount: number
  skipped: number
  anonymized: number
  truncated: boolean
}

/**
 * The default start date: 16 months back.
 *
 * Search Console keeps 16 months and silently returns nothing older, so asking
 * for more is not an error — it just quietly returns less than requested, which
 * would read as "the site had no traffic in 2019" rather than "Google does not
 * have it". `now` is injectable so the boundary is testable.
 */
export function defaultStartDate(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 16, now.getUTCDate()))
  return d.toISOString().slice(0, 10)
}

/** Yesterday, since `dataState: 'final'` has nothing for today. */
export function defaultEndDate(now: Date = new Date()): string {
  const d = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

export async function fetchSearchConsoleHistory(
  options: SearchConsoleFetchOptions,
): Promise<SearchConsoleFetchResult> {
  const siteUrl = normalizeSiteUrl(options.siteUrl)
  if (!siteUrl) {
    throw new Error('That is not a Search Console property. Use "sc-domain:example.com" for a domain property, or the full URL including the trailing slash for a URL-prefix property.')
  }

  const token = await getAccessToken(options.key, SEARCH_CONSOLE_SCOPE)
  const report = await runSearchAnalytics(
    token,
    siteUrl,
    {
      startDate: options.startDate || defaultStartDate(),
      endDate: options.endDate || defaultEndDate(),
    },
    options.fetchImpl,
  )
  const { records, skipped, anonymized } = toSearchRecords(report.rows)
  return {
    records,
    rowCount: report.rows.length,
    skipped,
    anonymized,
    truncated: report.truncated,
  }
}

/** Deterministic row id — see the migration for why re-imports must converge. */
export async function searchRowId(siteId: string, rec: SearchQueryRecord): Promise<string> {
  const input = `${siteId}|${rec.date}|${rec.query}|${rec.path}`
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40)
}

export const SEARCH_QUERY_COLUMNS = ['id', 'site_id', 'date', 'query', 'path', 'clicks', 'impressions', 'position'] as const

/**
 * Build the multi-row upsert.
 *
 * ON CONFLICT DO UPDATE, not DO NOTHING: Search Console revises the last few
 * days after the fact, so re-importing an overlapping range is normal and must
 * converge on Google's current numbers rather than keep the first ones seen.
 */
export function buildSearchInsert(rows: Record<string, unknown>[]): { sql: string, params: unknown[] } | null {
  if (rows.length === 0)
    return null
  const cols = SEARCH_QUERY_COLUMNS
  const placeholders = rows.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')
  const params = rows.flatMap(row => cols.map(c => row[c]))
  return {
    sql: `INSERT INTO search_queries (${cols.join(', ')}) VALUES ${placeholders}
          ON CONFLICT (id) DO UPDATE SET
            clicks = EXCLUDED.clicks,
            impressions = EXCLUDED.impressions,
            position = EXCLUDED.position`,
    params,
  }
}
