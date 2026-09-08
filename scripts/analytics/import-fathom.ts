/**
 * Import historical analytics from a Fathom dashboard CSV export into a site.
 *
 *   bun scripts/analytics/import-fathom.ts \
 *     --site=<analyticshq-site-id> --dir=<Dashboard_Export_folder> \
 *     [--replace] [--dry-run]
 *
 * Point `--dir` at the folder Fathom's "Export" button produces - the one with
 * Summary.csv, Pages.csv, Browsers.csv and the rest in it, not at a single file.
 *
 * Fathom exports AGGREGATES with no timestamps and no cross-tabulation, so the
 * rows written here are synthesized: they reproduce Fathom's totals rather than
 * recovering its events, which is not possible from this data. What that means
 * in practice, and the one question it cannot answer, is documented at the top
 * of app/Analytics/fathom-import.ts - read it before trusting a segmented view
 * of imported history.
 *
 * The synthesis and the insert are shared with the GA importer so the two
 * cannot drift. Only the reading and the dimension allocation are Fathom's.
 *
 * Synthetic rows use `fap_`/`fas_` id prefixes, so `--replace` wipes a prior
 * Fathom import for this site without touching real traffic or a GA import.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildInsert,
  splitCsv,
  synthesizeRecord,
  toInt,
} from '../../app/Analytics/ga-import'
import {
  FATHOM_PAGE_VIEW_PREFIX,
  FATHOM_SESSION_PREFIX,
  parseBreakdown,
  parseRange,
  parseSummaryTotals,
  reconcileVisitors,
  toRecords,
  type FathomExport,
} from '../../app/Analytics/fathom-import'
import { connect, log, parseArgs, requireArg, requireSite } from './lib'

const USAGE = 'usage: import-fathom --site=<analyticshq-id> --dir=<export-folder> [--replace] [--dry-run]'
const args = parseArgs()
const siteId = requireArg(args, 'site', USAGE)
const dir = requireArg(args, 'dir', USAGE)
const dryRun = args['dry-run'] === true
const replace = args.replace === true

/** Missing breakdown files are normal - Fathom omits ones with no data. */
function readOptional(name: string): string {
  const p = join(dir, name)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

const summary = readOptional('Summary.csv')
if (!summary) {
  log(`error: ${join(dir, 'Summary.csv')} not found. Point --dir at the export FOLDER, not a single CSV.`)
  process.exit(1)
}

const range = parseRange(summary)
if (!range) {
  log('error: could not read the date range from Summary.csv. Expected a cell like "2026-09-02 00:00:00 to 2026-09-08 16:02:04 (UTC)".')
  process.exit(1)
}

// Pages.csv carries the visitor AND pageview counts, so it is the spine of the
// import: every other file only splits those visitors by one dimension.
const pageLines = readOptional('Pages.csv').split(/\r?\n/).filter(l => l.trim() !== '')
if (pageLines.length < 2) {
  log('error: Pages.csv has no data rows. Nothing to import.')
  process.exit(1)
}
const pages = new Map<string, { visitors: number, pageviews: number }>()
for (const line of pageLines.slice(1)) {
  const c = splitCsv(line)
  const path = (c[0] || '').trim()
  if (!path)
    continue
  const prev = pages.get(path)
  const visitors = toInt(c[1])
  const pageviews = toInt(c[2]) || visitors
  pages.set(path, {
    visitors: (prev?.visitors ?? 0) + visitors,
    pageviews: (prev?.pageviews ?? 0) + pageviews,
  })
}

const totals = parseSummaryTotals(summary)

const exportData: FathomExport = {
  from: range.from,
  to: range.to,
  people: totals.people,
  pageviews: totals.pageviews,
  pages,
  countries: parseBreakdown(readOptional('Countries.csv')),
  devices: parseBreakdown(readOptional('Device_Types.csv')),
  browsers: parseBreakdown(readOptional('Browsers.csv')),
  systems: parseBreakdown(readOptional('Operating_Systems.csv')),
  sources: parseBreakdown(readOptional('Sources.csv')),
}

// Reported before anything is written, because a scaled import is not a failure
// but it is a thing the person running it has to know: their per-page visitor
// numbers will read lower than Fathom's, by design. See reconcileVisitors.
const recon = reconcileVisitors(pages, totals.people)
if (recon.rawTotal > recon.total)
  log(`reconciled: Pages.csv counts ${recon.rawTotal} visitors across pages, Summary.csv says ${totals.people} people. Scaling to ${recon.total} so the country, device, browser and source totals still match Fathom.`)
else if (totals.people > 0 && recon.total > totals.people)
  log(`note: ${pages.size} pages but only ${totals.people} people, so every page keeps one visitor and the import totals ${recon.total}.`)

const records = toRecords(exportData)
const sql = connect()
const site = await requireSite(sql, siteId)
log(`import-fathom → "${site.name}" (${siteId})  ${range.from}..${range.to}  ${records.length} records${dryRun ? '  [dry-run]' : ''}`)

if (replace && !dryRun) {
  const d1 = await sql`DELETE FROM page_views WHERE site_id = ${siteId} AND id LIKE ${`${FATHOM_PAGE_VIEW_PREFIX}%`}`
  const d2 = await sql`DELETE FROM sessions WHERE site_id = ${siteId} AND id LIKE ${`${FATHOM_SESSION_PREFIX}%`}`
  log(`--replace: removed ${d1.count ?? 0} prior imported page_views, ${d2.count ?? 0} sessions`)
}

const now = new Date()
const prefixes = { pageView: FATHOM_PAGE_VIEW_PREFIX, session: FATHOM_SESSION_PREFIX }
let totalPv = 0
let totalSess = 0
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

for (const record of records) {
  const rows = synthesizeRecord(siteId, record, now, prefixes)
  sessBuf.push(...rows.sessions)
  pvBuf.push(...rows.pageViews)
  totalSess += rows.sessions.length
  totalPv += rows.pageViews.length
  if (pvBuf.length >= 2000)
    await flush()
}
await flush()

log(dryRun
  ? `dry-run: would import ~${totalPv} page_views / ${totalSess} sessions from ${records.length} records (nothing written)`
  : `done: imported ${totalPv} page_views / ${totalSess} sessions from ${records.length} records`)

await sql.end()
