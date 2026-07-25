/**
 * Import historical analytics from Fathom into a analyticshq site.
 *
 *   bun scripts/analytics/import-fathom.ts \
 *     --token=<fathom-api-token> --fathom-site=<XXXXX> --site=<ghost-site-id> \
 *     [--from=2021-03-01] [--to=2026-07-01] [--replace] [--dry-run] [--with-utm] \
 *     [--mock=aggs.json]
 *
 * Fathom only stores AGGREGATES, so we can't recover individual pageviews. We
 * query /aggregations grouped by ALL dimensions per day, then SYNTHESIZE raw
 * page_views + sessions that reproduce those totals (visitor/session counts are
 * sized from Fathom's uniques/visits and are therefore approximate). The result
 * flows through the normal dashboard exactly like native data.
 *
 * Synthetic rows use `fim_`/`fis_` id prefixes so a re-run with --replace can wipe
 * a prior Fathom import for this site without touching real data. Accurate from
 * March 2021 onwards (Fathom's own limit). API is rate-limited (10/min), so we
 * chunk by month and pace requests.
 *
 * --mock=<file> reads a JSON array of aggregation rows instead of calling Fathom
 * (for testing the synthesis + insert path offline).
 */
import { connect, isoStamp, log, parseArgs, requireArg, requireSite, shortHash } from './lib'

const FATHOM_API = 'https://api.usefathom.com/v1/aggregations'
const USAGE = 'usage: import-fathom --token=<t> --fathom-site=<id> --site=<ghost-id> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--replace] [--dry-run] [--with-utm] [--mock=file]'

const args = parseArgs()
const siteId = requireArg(args, 'site', USAGE)
const mockFile = args.mock as string | undefined
const token = mockFile ? '' : requireArg(args, 'token', USAGE)
const fathomSite = mockFile ? '' : requireArg(args, 'fathom-site', USAGE)
const from = new Date(`${(args.from as string) || '2021-03-01'}T00:00:00Z`)
const to = new Date(`${(args.to as string) || new Date().toISOString().slice(0, 10)}T23:59:59Z`)
const dryRun = args['dry-run'] === true
const replace = args.replace === true
const withUtm = args['with-utm'] === true

const DIMS = ['pathname', 'referrer_hostname', 'referrer_source', 'country_code', 'device_type', 'browser', 'operating_system']
if (withUtm)
  DIMS.push('utm_source', 'utm_medium', 'utm_campaign')

const sql = connect()
const site = await requireSite(sql, siteId)
log(`import-fathom → "${site.name}" (${siteId})  range ${from.toISOString().slice(0, 10)}…${to.toISOString().slice(0, 10)}${dryRun ? '  [dry-run]' : ''}`)

if (replace && !dryRun) {
  const d1 = await sql`DELETE FROM page_views WHERE site_id = ${siteId} AND id LIKE 'fip_%'`
  const d2 = await sql`DELETE FROM sessions WHERE site_id = ${siteId} AND id LIKE 'fis_%'`
  log(`--replace: removed ${d1.count ?? 0} prior imported page_views, ${d2.count ?? 0} sessions`)
}

// --- normalization to match the tracker's stored casing -------------------
const OS_MAP: Record<string, string> = { 'Mac OS X': 'macOS', 'Mac OS': 'macOS', macOS: 'macOS', 'OS X': 'macOS' }
const normDevice = (v: string) => (v || '').toLowerCase() || 'unknown'
const normOs = (v: string) => OS_MAP[v] || v || 'Unknown'

// --- Fathom fetch (month-chunked, rate-limited) ---------------------------
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function fmtTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

async function fetchMonth(monthStart: Date, monthEnd: Date): Promise<any[]> {
  const qs = new URLSearchParams({
    entity: 'pageview',
    entity_id: fathomSite,
    aggregates: 'pageviews,visits,uniques',
    field_grouping: DIMS.join(','),
    date_grouping: 'day',
    date_from: fmtTs(monthStart),
    date_to: fmtTs(monthEnd),
  })
  const res = await fetch(`${FATHOM_API}?${qs}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Fathom API ${res.status}: ${body.slice(0, 200)}`)
  }
  return await res.json() as any[]
}

// Yield [monthStart, monthEnd] windows covering [from, to].
function* months(start: Date, end: Date): Generator<[Date, Date]> {
  let y = start.getUTCFullYear(); let m = start.getUTCMonth()
  for (;;) {
    const ms = new Date(Date.UTC(y, m, 1, 0, 0, 0))
    const me = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59))
    if (ms > end)
      return
    yield [new Date(Math.max(ms.getTime(), start.getTime())), new Date(Math.min(me.getTime(), end.getTime()))]
    m++
    if (m > 11) { m = 0; y++ }
  }
}

// --- synthesis ------------------------------------------------------------
const now = new Date()
let totalPv = 0; let totalSess = 0; let aggRows = 0

const pvBuf: any[] = []
const sessBuf: any[] = []

async function flush() {
  if (dryRun) { pvBuf.length = 0; sessBuf.length = 0; return }
  if (sessBuf.length)
    await sql`INSERT INTO sessions ${sql(sessBuf)}`
  if (pvBuf.length)
    await sql`INSERT INTO page_views ${sql(pvBuf)}`
  sessBuf.length = 0
  pvBuf.length = 0
}

async function synthesize(row: any, fallbackDay: Date): Promise<void> {
  const P = Number.parseInt(row.pageviews ?? '0', 10)
  if (!Number.isFinite(P) || P <= 0)
    return
  const V = Math.min(Math.max(Number.parseInt(row.visits ?? '1', 10) || 1, 1), P)
  const U = Math.min(Math.max(Number.parseInt(row.uniques ?? '1', 10) || 1, 1), V)

  const dayStr = typeof row.date === 'string' ? row.date.slice(0, 10) : ''
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayStr) ? new Date(`${dayStr}T00:00:00Z`) : fallbackDay
  const rowKey = await shortHash(`${siteId}|${day.toISOString().slice(0, 10)}|${DIMS.map(d => row[d] ?? '').join('|')}`)

  const path = row.pathname || '/'
  const refHost = row.referrer_hostname || ''
  const referrer = refHost ? `https://${refHost}/` : ''
  const referrerSource = row.referrer_source || (refHost ? refHost : 'Direct')
  const country = row.country_code || null
  const device = normDevice(row.device_type)
  const browser = row.browser || 'Unknown'
  const os = normOs(row.operating_system)
  const utm_source = row.utm_source || null
  const utm_medium = row.utm_medium || null
  const utm_campaign = row.utm_campaign || null

  const counts = Array.from({ length: V }, () => 0)
  for (let k = 0; k < P; k++) counts[k % V]++

  const seen = new Set<string>()
  const daySpan = 86400 * 0.92
  for (let j = 0; j < V; j++) {
    const visitor = `fim_${rowKey}_${j % U}`
    const c = counts[j]
    const bounce = c === 1
    const start = new Date(day.getTime() + Math.floor((j / Math.max(V, 1)) * daySpan) * 1000)
    sessBuf.push({
      id: `fis_${rowKey}_${j}`,
      site_id: siteId,
      visitor_id: visitor,
      entry_path: path,
      referrer,
      referrer_source: referrerSource,
      utm_source,
      utm_medium,
      utm_campaign,
      country,
      device_type: device,
      browser,
      os,
      page_view_count: c,
      is_bounce: bounce,
      duration: c > 1 ? (c - 1) * 45 : 0,
      started_at: isoStamp(start),
      created_at: now,
      updated_at: now,
    })
    totalSess++
    for (let m = 0; m < c; m++) {
      const isUnique = m === 0 && !seen.has(visitor)
      if (isUnique)
        seen.add(visitor)
      pvBuf.push({
        id: `fip_${rowKey}_${j}_${m}`,
        site_id: siteId,
        session_id: `fis_${rowKey}_${j}`,
        visitor_id: visitor,
        path,
        hostname: refHost || null,
        referrer,
        referrer_source: referrerSource,
        utm_source,
        utm_medium,
        utm_campaign,
        country,
        device_type: device,
        browser,
        os,
        is_unique: isUnique,
        is_bounce: bounce,
        time_on_page: m < c - 1 ? 45 : 0,
        timestamp: isoStamp(new Date(start.getTime() + m * 45000)),
        created_at: now,
        updated_at: now,
      })
      totalPv++
    }
    if (pvBuf.length >= 2000)
      await flush()
  }
}

// --- run ------------------------------------------------------------------
if (mockFile) {
  const rows = await Bun.file(mockFile).json() as any[]
  log(`[mock] ${rows.length} aggregation rows from ${mockFile}`)
  for (const row of rows) {
    aggRows++
    await synthesize(row, from)
  }
  await flush()
}
else {
  const monthList = [...months(from, to)]
  for (let i = 0; i < monthList.length; i++) {
    const [ms, me] = monthList[i]
    const label = ms.toISOString().slice(0, 7)
    let rows: any[]
    try {
      rows = await fetchMonth(ms, me)
    }
    catch (e: any) {
      log(`  ${label}: ${e.message}`)
      if (String(e.message).includes(' 401'))
        process.exit(1)
      continue
    }
    log(`  ${label}: ${rows.length} rows`)
    for (const row of rows) {
      aggRows++
      await synthesize(row, ms)
    }
    await flush()
    if (i < monthList.length - 1)
      await sleep(6500) // stay under Fathom's 10 req/min on aggregations
  }
}

log(dryRun
  ? `dry-run: would import ~${totalPv} page_views / ${totalSess} sessions from ${aggRows} Fathom rows (nothing written)`
  : `done: imported ${totalPv} page_views / ${totalSess} sessions from ${aggRows} Fathom rows`)

await sql.end()
