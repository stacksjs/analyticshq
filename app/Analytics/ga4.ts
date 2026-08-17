/**
 * GA4 Data API client — the import path with no spreadsheet in it (#13 follow-up).
 *
 * `scripts/analytics/import-ga.ts` reads a CSV a human exported from GA4. This
 * pulls the same numbers straight from Google, which is what the marketing copy
 * has been describing all along ("without a spreadsheet or a migration project").
 *
 * ## Auth is a service-account key, NOT OAuth, and that is a product decision
 *
 * OAuth would need us to register an application with Google, run a consent
 * screen, pass verification for a sensitive scope, and hold refresh tokens for
 * our customers' Google accounts. That is a standing dependency on Google and a
 * pile of long-lived credentials — for a product whose entire pitch is not being
 * that. It is also the open question in #25, which is why this path deliberately
 * does not wait on it.
 *
 * With a service account the customer creates the credential inside their OWN
 * Google Cloud project, grants its email Viewer on their GA4 property, and hands
 * us the key for one import. We register nothing with Google, and the key is
 * used and dropped — never written to the database, never logged, never included
 * in an error message (see `redactKey`).
 *
 * ## Test seams
 *
 * GA4_TOKEN_URL and GA4_API_BASE let a harness stand in for Google, so the whole
 * path — JWT signing, token exchange, pagination, folding — is exercised without
 * a network or a real Google project.
 */
import { type GaRecord, toRecord } from './ga-import'
import { getAccessToken as exchangeToken, SCOPE_ANALYTICS_READONLY } from './google-auth'

/**
 * Auth lives in ./google-auth, shared with the Search Console import (#25).
 *
 * Re-exported here rather than made an import-site change at every caller: the
 * CLI, the endpoint and the tests all reached for these through ga4.ts, and a
 * module that quietly stops exporting what it used to is a worse trade than one
 * extra line per name.
 */
export {
  buildAssertion,
  getAccessToken,
  parseServiceAccountKey,
  redactKey,
  type ServiceAccountKey,
} from './google-auth'

const API_BASE = (): string => process.env.GA4_API_BASE || 'https://analyticsdata.googleapis.com'

/**
 * The scope this importer signs its assertion with, exported so a test can
 * assert the value the call site actually passes rather than grepping for a
 * string literal that has since moved to another file.
 */
export const GA4_SCOPE = SCOPE_ANALYTICS_READONLY

/**
 * The single report the import runs.
 *
 * ONE report, not one per dimension family, and this is the correctness point
 * rather than an optimisation. Each GA report totals the same traffic sliced a
 * different way, so synthesizing from two of them would count every visit twice.
 * The CSV importer has the same shape for the same reason — it reads one file.
 *
 * The dimensions are exactly the ones `page_views` stores, so an import fills
 * every dashboard panel rather than leaving the device or browser reports empty
 * for imported history.
 */
export const GA4_DIMENSIONS = ['date', 'pagePath', 'sessionSource', 'sessionMedium', 'sessionCampaignName', 'country', 'deviceCategory', 'browser', 'operatingSystem'] as const
export const GA4_METRICS = ['screenPageViews', 'sessions', 'totalUsers'] as const

/** Rows GA4 returns per page. Google's documented maximum for runReport. */
const PAGE_SIZE = 100_000
/** Hard stop, so a runaway property cannot page forever. Reported when hit. */
const MAX_PAGES = 50

export interface Ga4Row {
  dimensionValues?: Array<{ value?: string }>
  metricValues?: Array<{ value?: string }>
}

export interface Ga4Report {
  rows: Ga4Row[]
  /** True when GA stopped paginating us at MAX_PAGES — the import is partial. */
  truncated: boolean
  /** Google's own total, for reporting how much of it we actually read. */
  rowCount: number
  /** True when GA bucketed high-cardinality dimensions into "(other)". */
  sampled: boolean
}

/**
 * Run the report, following pagination.
 *
 * `fetchImpl` is injectable so the pagination and the error handling can be
 * tested against canned responses — this loop is where an off-by-one silently
 * drops the last page of somebody's history.
 */
export async function runReport(
  token: string,
  propertyId: string,
  dateRange: { startDate: string, endDate: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Ga4Report> {
  const rows: Ga4Row[] = []
  let rowCount = 0
  let truncated = false
  let page = 0

  for (; page < MAX_PAGES; page++) {
    const res = await fetchImpl(`${API_BASE()}/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [dateRange],
        dimensions: GA4_DIMENSIONS.map(name => ({ name })),
        metrics: GA4_METRICS.map(name => ({ name })),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        // Without this GA returns rows for dimension combinations that had no
        // traffic, which synthesize into nothing but cost a round trip each.
        keepEmptyRows: false,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`GA4 refused the report (${res.status}): ${redactKey(body).slice(0, 300)}`)
    }
    const data = await res.json() as { rows?: Ga4Row[], rowCount?: number }
    const batch = data.rows ?? []
    rows.push(...batch)
    rowCount = data.rowCount ?? rows.length
    if (batch.length < PAGE_SIZE)
      break
    if (rows.length >= rowCount)
      break
  }
  if (page >= MAX_PAGES && rows.length < rowCount)
    truncated = true

  // GA4 collapses dimension values it cannot handle at the requested cardinality
  // into a literal "(other)" row. Those rows are real traffic under a fake label,
  // so an import that silently keeps them attributes visits to a page called
  // "(other)". Detected and reported rather than quietly imported.
  const sampled = rows.some(r => (r.dimensionValues ?? []).some(d => d.value === '(other)'))

  return { rows, truncated, rowCount, sampled }
}

/**
 * Turn API rows into the records the shared synthesis understands.
 *
 * Positional, because GA4 returns dimensions and metrics in the order they were
 * requested and names them nowhere in the response. The order therefore has to
 * match GA4_DIMENSIONS/GA4_METRICS exactly, which is why both are declared once,
 * above, and used to build the request as well as to read the reply.
 */
export function toRecords(rows: Ga4Row[]): { records: GaRecord[], skipped: number, other: number } {
  const records: GaRecord[] = []
  let skipped = 0
  let other = 0
  for (const row of rows) {
    const d = (row.dimensionValues ?? []).map(v => v.value ?? '')
    const m = (row.metricValues ?? []).map(v => v.value ?? '')
    // A row bucketed by GA is traffic we cannot attribute; counting it under the
    // literal string "(other)" would put a fictional page in the pages report.
    if (d.includes('(other)')) {
      other++
      continue
    }
    const rec = toRecord({
      date: d[0],
      path: d[1],
      source: d[2],
      medium: d[3],
      campaign: d[4],
      country: d[5],
      device: d[6],
      browser: d[7],
      os: d[8],
      pageviews: m[0],
      sessions: m[1],
      users: m[2],
    })
    if (rec)
      records.push(rec)
    else skipped++
  }
  return { records, skipped, other }
}

/**
 * Every way an import can be incomplete, in the words the person sees.
 *
 * A function rather than three `if`s at the call site, because "a partial import
 * always says so" is the property that matters and it should be testable by
 * calling something. A source-level check that the endpoint mentions the word
 * "capped" passes just as well when the branch has been disabled.
 *
 * Silence here is the dangerous outcome: a partial import that reports success
 * surfaces months later as a traffic drop that never happened, and nobody thinks
 * to blame the importer.
 */
export function importWarnings(state: {
  capped: boolean
  truncated: boolean
  other: number
  maxRows: number
}): string[] {
  const out: string[] = []
  if (state.capped)
    out.push(`This period has more traffic than one import can take (over ${state.maxRows.toLocaleString()} page views), so it is incomplete. Import it in shorter periods.`)
  if (state.truncated)
    out.push('Google had more rows than we could page through for this period. Import it in shorter periods.')
  if (state.other > 0)
    out.push(`Google grouped ${state.other.toLocaleString()} rows under "(other)" because the property has more distinct pages or sources than it will report individually. That traffic could not be attributed to a real page and was not imported.`)
  return out
}

/** GA4 rejects a property id that is not the bare numeric one. */
export function normalizePropertyId(raw: string): string | null {
  const id = String(raw ?? '').replace(/^properties\//, '').trim()
  return /^\d+$/.test(id) ? id : null
}

export interface Ga4FetchOptions {
  propertyId: string
  key: ServiceAccountKey
  /** ISO date. GA4 holds no data before 2015. */
  startDate?: string
  /** ISO date, or a GA relative token like 'yesterday'. */
  endDate?: string
  fetchImpl?: typeof fetch
}

export interface Ga4FetchResult {
  records: GaRecord[]
  rowCount: number
  skipped: number
  other: number
  truncated: boolean
  sampled: boolean
}

/** Authenticate, pull the property's history, and normalize it. */
export async function fetchGa4History(options: Ga4FetchOptions): Promise<Ga4FetchResult> {
  const propertyId = normalizePropertyId(options.propertyId)
  if (!propertyId)
    throw new Error('The property id must be the numeric GA4 id (the digits in "properties/123456789").')

  const token = await exchangeToken(options.key, GA4_SCOPE)
  const report = await runReport(
    token,
    propertyId,
    {
      // GA4 itself did not exist before 2015; an earlier start is silently
      // clamped by Google, so asking for it only wastes the request.
      startDate: options.startDate || '2015-08-14',
      endDate: options.endDate || 'yesterday',
    },
    options.fetchImpl,
  )
  const { records, skipped, other } = toRecords(report.rows)
  return {
    records,
    rowCount: report.rowCount,
    skipped,
    other,
    truncated: report.truncated,
    sampled: report.sampled || other > 0,
  }
}
