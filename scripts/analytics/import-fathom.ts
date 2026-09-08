/**
 * Import historical analytics from a Fathom dashboard CSV export into a site.
 *
 *   bun scripts/analytics/import-fathom.ts \
 *     --site=<analyticshq-site-id> --dir=<Dashboard_Export_folder> \
 *     [--replace] [--dry-run] [--force-filtered]
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
import { buildInsert, synthesizeRecord } from '../../app/Analytics/ga-import'
import {
  FATHOM_FILES,
  FATHOM_PAGE_VIEW_PREFIX,
  FATHOM_SESSION_PREFIX,
  fathomImportWarnings,
  readFathomExport,
  toRecords,
} from '../../app/Analytics/fathom-import'
import { connect, log, parseArgs, requireArg, requireSite } from './lib'

const USAGE = 'usage: import-fathom --site=<analyticshq-id> --dir=<export-folder> [--replace] [--dry-run] [--force-filtered]'
const args = parseArgs()
const siteId = requireArg(args, 'site', USAGE)
const dir = requireArg(args, 'dir', USAGE)
const dryRun = args['dry-run'] === true
const replace = args.replace === true
const forceFiltered = args['force-filtered'] === true

// Missing breakdown files are normal - Fathom omits ones with no data - so the
// folder is read permissively here and judged by the shared reader, which is the
// same one the upload endpoint uses. Neither caller decides on its own what a
// Fathom export has to contain.
const files = new Map<string, string>()
for (const name of FATHOM_FILES) {
  const p = join(dir, name)
  if (existsSync(p))
    files.set(name, readFileSync(p, 'utf8'))
}
if (!files.size) {
  log(`error: no Fathom CSVs in ${dir}. Point --dir at the export FOLDER, not a single CSV.`)
  process.exit(1)
}

const read = readFathomExport(files)
if ('error' in read) {
  log(`error: ${read.error}`)
  process.exit(1)
}

// A filtered export is a subset of the site that looks exactly like a complete
// one, so it takes a deliberate flag rather than a warning nobody reads.
if (read.notes.filtersApplied > 0 && !forceFiltered) {
  log('error: Summary.csv reports filters were applied, so this export is a subset of the site. Re-export with the filters cleared, or pass --force-filtered to import the subset anyway.')
  process.exit(1)
}

for (const w of fathomImportWarnings(read.notes))
  log(`warning: ${w}`)

const exportData = read.export
const range = { from: exportData.from, to: exportData.to }
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
