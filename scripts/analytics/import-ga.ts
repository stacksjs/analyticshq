/**
 * Import historical analytics from a Google Analytics (GA4) CSV export into a
 * analyticshq site.
 *
 *   bun scripts/analytics/import-ga.ts \
 *     --site=<analyticshq-site-id> --file=<ga4-export.csv> \
 *     [--from=2023-01-01] [--to=2026-07-01] [--replace] [--dry-run]
 *
 * If you can create a service account in the Google Cloud project that owns the
 * property, `import-ga4.ts` pulls the same data straight from the Data API and
 * there is no CSV to export at all. This script stays because not everybody can:
 * a marketing team with Analytics access but no Cloud console has an export
 * button and nothing else.
 *
 * GA4 (like Fathom) only exports AGGREGATES, so individual pageviews can't be
 * recovered. Export a GA4 report/exploration as CSV with a Date dimension plus
 * any of: Page path, Session source, Country, Device category, Browser,
 * Operating system — and the Views + Sessions + Total users metrics. Column
 * names are matched case/spacing-insensitively.
 *
 * The mapping, the synthesis and the write live in app/Analytics/ga-import.ts,
 * shared with the API importer — the two must produce identical rows for the
 * same property, and a second copy of the synthesis here would be free to drift.
 *
 * Synthetic rows use `gap_`/`gas_` id prefixes, so `--replace` wipes a prior GA
 * import for this site without touching real data (or a Fathom import). GA4's CSV
 * export prefixes metadata lines with `#`, which are skipped; the first real row
 * is treated as the header.
 */
import {
  buildInsert,
  GA_PAGE_VIEW_PREFIX,
  GA_SESSION_PREFIX,
  resolveColumns,
  splitCsv,
  synthesizeRecord,
  toRecord,
} from '../../app/Analytics/ga-import'
import { connect, log, parseArgs, requireArg, requireSite } from './lib'

const USAGE = 'usage: import-ga --site=<analyticshq-id> --file=<ga4-export.csv> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--replace] [--dry-run]'
const args = parseArgs()
const siteId = requireArg(args, 'site', USAGE)
const file = requireArg(args, 'file', USAGE)
const from = new Date(`${(args.from as string) || '2000-01-01'}T00:00:00Z`)
const to = new Date(`${(args.to as string) || new Date().toISOString().slice(0, 10)}T23:59:59Z`)
const dryRun = args['dry-run'] === true
const replace = args.replace === true

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
  const d1 = await sql`DELETE FROM page_views WHERE site_id = ${siteId} AND id LIKE ${`${GA_PAGE_VIEW_PREFIX}%`}`
  const d2 = await sql`DELETE FROM sessions WHERE site_id = ${siteId} AND id LIKE ${`${GA_SESSION_PREFIX}%`}`
  log(`--replace: removed ${d1.count ?? 0} prior imported page_views, ${d2.count ?? 0} sessions`)
}

const cell = (row: string[], field: string): string => (cols[field] !== undefined ? (row[cols[field]] ?? '').trim() : '')

const now = new Date()
let totalPv = 0
let totalSess = 0
let aggRows = 0
let skipped = 0
let pvBuf: Record<string, unknown>[] = []
let sessBuf: Record<string, unknown>[] = []

async function flush(): Promise<void> {
  if (dryRun) { pvBuf = []; sessBuf = []; return }
  // Sessions first: page_views.session_id has a foreign key to it.
  const s = buildInsert('sessions', sessBuf)
  if (s)
    await sql.unsafe(s.sql, s.params)
  const p = buildInsert('page_views', pvBuf)
  if (p)
    await sql.unsafe(p.sql, p.params)
  sessBuf = []
  pvBuf = []
}

for (let i = 1; i < lines.length; i++) {
  const row = splitCsv(lines[i])
  aggRows++

  const record = toRecord({
    date: cell(row, 'date'),
    path: cell(row, 'path'),
    source: cell(row, 'source'),
    medium: cell(row, 'medium'),
    campaign: cell(row, 'campaign'),
    country: cell(row, 'country'),
    device: cell(row, 'device'),
    browser: cell(row, 'browser'),
    os: cell(row, 'os'),
    pageviews: cell(row, 'pageviews'),
    sessions: cell(row, 'sessions'),
    users: cell(row, 'users'),
    pageviewsMissing: cols.pageviews === undefined,
    sessionsMissing: cols.sessions === undefined,
    usersMissing: cols.users === undefined,
  })
  if (!record) { skipped++; continue }

  const day = new Date(`${record.date}T00:00:00Z`)
  if (day < from || day > to) { skipped++; continue }

  const rows = synthesizeRecord(siteId, record, now)
  sessBuf.push(...rows.sessions)
  pvBuf.push(...rows.pageViews)
  totalSess += rows.sessions.length
  totalPv += rows.pageViews.length
  if (pvBuf.length >= 2000)
    await flush()
}
await flush()

log(dryRun
  ? `dry-run: would import ~${totalPv} page_views / ${totalSess} sessions from ${aggRows} GA rows (${skipped} skipped, nothing written)`
  : `done: imported ${totalPv} page_views / ${totalSess} sessions from ${aggRows} GA rows (${skipped} skipped)`)

await sql.end()
