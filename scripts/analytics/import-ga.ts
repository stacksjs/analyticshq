/**
 * Import historical analytics from a Google Analytics (GA4) export into a
 * analyticshq site.
 *
 *   bun scripts/analytics/import-ga.ts \
 *     --site=<analyticshq-site-id> --file=<ga4-export.csv> \
 *     [--from=2023-01-01] [--to=2026-07-01] [--replace] [--dry-run]
 *
 * GA4 (like Fathom) only exports AGGREGATES, so individual pageviews can't be
 * recovered. Export a GA4 report/exploration as CSV with a Date dimension plus
 * any of: Page path, Session source, Country, Device category, Browser,
 * Operating system — and the Views + Sessions + Total users metrics. We map the
 * columns (GA4 names vary, so matching is fuzzy) and SYNTHESIZE page_views +
 * sessions that reproduce the totals, flowing through the dashboard like native
 * data. Column names are matched case/spacing-insensitively.
 *
 * Synthetic rows use `gap_`/`gas_` id prefixes, so `--replace` wipes a prior GA
 * import for this site without touching real data (or a Fathom import). GA4's CSV
 * export prefixes metadata lines with `#`, which are skipped; the first real row
 * is treated as the header.
 */
import { connect, isoStamp, log, parseArgs, requireArg, requireSite, shortHash } from './lib'

const USAGE = 'usage: import-ga --site=<analyticshq-id> --file=<ga4-export.csv> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--replace] [--dry-run]'
const args = parseArgs()
const siteId = requireArg(args, 'site', USAGE)
const file = requireArg(args, 'file', USAGE)
const from = new Date(`${(args.from as string) || '2000-01-01'}T00:00:00Z`)
const to = new Date(`${(args.to as string) || new Date().toISOString().slice(0, 10)}T23:59:59Z`)
const dryRun = args['dry-run'] === true
const replace = args.replace === true

// --- CSV parsing ----------------------------------------------------------
/** Quote-aware split of a single CSV line. */
function splitCsv(line: string): string[] {
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

// Map a analyticshq field to the GA4 column names it may appear under
// (normalized: lowercased, non-alphanumerics stripped).
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const ALIASES: Record<string, string[]> = {
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
function resolveColumns(header: string[]): Record<string, number> {
  const normed = header.map(norm)
  const idx: Record<string, number> = {}
  for (const [field, names] of Object.entries(ALIASES)) {
    const i = normed.findIndex(h => names.includes(h))
    if (i !== -1)
      idx[field] = i
  }
  return idx
}

/** GA4 dates come as YYYYMMDD or YYYY-MM-DD; normalize to YYYY-MM-DD. */
function normDate(v: string): string {
  const s = (v || '').trim()
  if (/^\d{8}$/.test(s))
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  return s.slice(0, 10)
}
const toInt = (v: string) => Math.max(0, Number.parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0)

const OS_MAP: Record<string, string> = { 'Mac OS X': 'macOS', 'Mac OS': 'macOS', Macintosh: 'macOS', 'OS X': 'macOS' }
const normDevice = (v: string) => (v || '').toLowerCase() || 'unknown'
const normOs = (v: string) => OS_MAP[v] || v || 'Unknown'
const clip = (v: string, n: number) => (v.length > n ? v.slice(0, n) : v)

// GA4's "Country" dimension is the full name; the store keeps a 2-letter code
// (varchar(2)). Prefer a 2-letter value as-is, else map common names, else null.
const COUNTRY_MAP: Record<string, string> = {
  'United States': 'US', 'United Kingdom': 'GB', Germany: 'DE', France: 'FR', Canada: 'CA', Australia: 'AU',
  India: 'IN', Japan: 'JP', Brazil: 'BR', Netherlands: 'NL', Spain: 'ES', Italy: 'IT', Sweden: 'SE',
  Switzerland: 'CH', Ireland: 'IE', Poland: 'PL', Mexico: 'MX', 'South Korea': 'KR', China: 'CN', Russia: 'RU',
  Norway: 'NO', Denmark: 'DK', Finland: 'FI', Belgium: 'BE', Austria: 'AT', Portugal: 'PT', Greece: 'GR',
  Turkey: 'TR', Israel: 'IL', 'South Africa': 'ZA', Singapore: 'SG', 'Hong Kong': 'HK', Taiwan: 'TW',
  Indonesia: 'ID', Thailand: 'TH', Malaysia: 'MY', Philippines: 'PH', Vietnam: 'VN', 'New Zealand': 'NZ',
  Argentina: 'AR', Chile: 'CL', Colombia: 'CO', Ukraine: 'UA', 'Czech Republic': 'CZ', Czechia: 'CZ',
  Romania: 'RO', Hungary: 'HU', 'United Arab Emirates': 'AE', 'Saudi Arabia': 'SA', Egypt: 'EG', Nigeria: 'NG',
  Pakistan: 'PK', Bangladesh: 'BD',
}
function normCountry(v: string): string | null {
  const s = (v || '').trim()
  if (/^[A-Za-z]{2}$/.test(s))
    return s.toUpperCase()
  return COUNTRY_MAP[s] || null
}

// --- load + map -----------------------------------------------------------
const text = await Bun.file(file).text()
const lines = text.split(/\r?\n/).filter(l => l.trim() !== '' && !l.startsWith('#'))
if (lines.length < 2) {
  log(`error: ${file} has no data rows (after skipping GA4 '#' metadata lines).`)
  process.exit(1)
}
const cols = resolveColumns(splitCsv(lines[0]))
if (cols.pageviews === undefined && cols.sessions === undefined) {
  log(`error: could not find a Views or Sessions column in ${file}. Header: ${lines[0].slice(0, 120)}`)
  process.exit(1)
}

const sql = connect()
const site = await requireSite(sql, siteId)
log(`import-ga → "${site.name}" (${siteId})  file ${file}${dryRun ? '  [dry-run]' : ''}`)

if (replace && !dryRun) {
  const d1 = await sql`DELETE FROM page_views WHERE site_id = ${siteId} AND id LIKE 'gap_%'`
  const d2 = await sql`DELETE FROM sessions WHERE site_id = ${siteId} AND id LIKE 'gas_%'`
  log(`--replace: removed ${d1.count ?? 0} prior imported page_views, ${d2.count ?? 0} sessions`)
}

const cell = (row: string[], field: string) => (cols[field] !== undefined ? (row[cols[field]] ?? '').trim() : '')

// --- synthesis (mirrors import-fathom) ------------------------------------
const now = new Date()
let totalPv = 0
let totalSess = 0
let aggRows = 0
let skipped = 0
const pvBuf: any[] = []
const sessBuf: any[] = []

async function flush(): Promise<void> {
  if (dryRun) { pvBuf.length = 0; sessBuf.length = 0; return }
  if (sessBuf.length)
    await sql`INSERT INTO sessions ${sql(sessBuf)}`
  if (pvBuf.length)
    await sql`INSERT INTO page_views ${sql(pvBuf)}`
  sessBuf.length = 0
  pvBuf.length = 0
}

async function synthesize(row: string[]): Promise<void> {
  const P = cols.pageviews !== undefined ? toInt(cell(row, 'pageviews')) : toInt(cell(row, 'sessions'))
  if (P <= 0) { skipped++; return }
  const S = cols.sessions !== undefined ? Math.min(Math.max(toInt(cell(row, 'sessions')), 1), P) : Math.max(1, Math.round(P / 2))
  const U = cols.users !== undefined ? Math.min(Math.max(toInt(cell(row, 'users')), 1), S) : S

  const dayStr = normDate(cell(row, 'date'))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) { skipped++; return }
  const day = new Date(`${dayStr}T00:00:00Z`)
  if (day < from || day > to) { skipped++; return }

  const path = clip(cell(row, 'path') || '/', 255)
  const source = cell(row, 'source') || 'Direct'
  const referrerSource = clip(/^(direct|\(direct\)|\(none\))$/i.test(source) ? 'Direct' : source, 128)
  const country = normCountry(cell(row, 'country'))
  const device = clip(normDevice(cell(row, 'device')), 16)
  const browser = clip(cell(row, 'browser') || 'Unknown', 32)
  const os = clip(normOs(cell(row, 'os')), 32)
  const utm_source = cell(row, 'source') ? clip(cell(row, 'source'), 255) : null
  const utm_medium = cell(row, 'medium') ? clip(cell(row, 'medium'), 64) : null
  const utm_campaign = cell(row, 'campaign') ? clip(cell(row, 'campaign'), 128) : null

  const rowKey = await shortHash(`${siteId}|${dayStr}|${path}|${source}|${country}|${device}|${browser}|${os}`)

  // distribute P pageviews across S sessions
  const counts = Array.from({ length: S }, () => 0)
  for (let k = 0; k < P; k++) counts[k % S]++

  const daySpan = 86400 * 0.92
  for (let j = 0; j < S; j++) {
    const visitor = `gap_${rowKey}_${j % U}`
    const c = counts[j]
    const bounce = c === 1
    const start = new Date(day.getTime() + Math.floor((j / Math.max(S, 1)) * daySpan) * 1000)
    sessBuf.push({
      id: `gas_${rowKey}_${j}`,
      site_id: siteId,
      visitor_id: visitor,
      entry_path: path,
      referrer: '',
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
      const isUnique = m === 0 && j < U
      pvBuf.push({
        id: `gap_${rowKey}_${j}_${m}`,
        site_id: siteId,
        session_id: `gas_${rowKey}_${j}`,
        visitor_id: visitor,
        path,
        hostname: null,
        referrer: '',
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

for (let i = 1; i < lines.length; i++) {
  const row = splitCsv(lines[i])
  aggRows++
  await synthesize(row)
}
await flush()

log(dryRun
  ? `dry-run: would import ~${totalPv} page_views / ${totalSess} sessions from ${aggRows} GA rows (${skipped} skipped, nothing written)`
  : `done: imported ${totalPv} page_views / ${totalSess} sessions from ${aggRows} GA rows (${skipped} skipped)`)

await sql.end()
