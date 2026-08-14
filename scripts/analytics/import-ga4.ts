/**
 * Import history straight from the Google Analytics (GA4) Data API — no CSV.
 *
 *   bun scripts/analytics/import-ga4.ts \
 *     --site=<analyticshq-site-id> --property=<numeric-ga4-property-id> \
 *     --key=<service-account.json> \
 *     [--from=2023-01-01] [--to=2026-07-01] [--replace] [--dry-run]
 *
 * ## Getting the credential
 *
 * In the Google Cloud project that owns the property: create a service account,
 * download its JSON key, enable the Google Analytics Data API, then in GA4 go to
 * Admin → Property access management and add the service account's email as a
 * Viewer. The account needs nothing else, and we register no application with
 * Google — see the note at the top of app/Analytics/ga4.ts for why this rather
 * than OAuth.
 *
 * The key is read, used for one token exchange, and never stored. It is also
 * never printed: `redactKey` scrubs Google's error bodies, which can echo parts
 * of a malformed assertion back at us.
 *
 * ## What arrives
 *
 * The same aggregates a CSV export contains, through the same synthesis — see
 * app/Analytics/ga-import.ts. Individual pageviews do not exist in GA4's API any
 * more than they do in its exports, so the rows are synthetic and reproduce the
 * daily totals. `--replace` removes a previous GA import (either importer) for
 * this site without touching real traffic.
 */
import {
  buildInsert,
  GA_PAGE_VIEW_PREFIX,
  GA_SESSION_PREFIX,
  synthesizeRecord,
} from '../../app/Analytics/ga-import'
import { fetchGa4History, parseServiceAccountKey } from '../../app/Analytics/ga4'
import { connect, log, parseArgs, requireArg, requireSite } from './lib'

const USAGE = 'usage: import-ga4 --site=<analyticshq-id> --property=<numeric-ga4-property-id> --key=<service-account.json> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--replace] [--dry-run]'
const args = parseArgs()
const siteId = requireArg(args, 'site', USAGE)
const property = requireArg(args, 'property', USAGE)
const keyPath = requireArg(args, 'key', USAGE)
const dryRun = args['dry-run'] === true
const replace = args.replace === true

const parsed = parseServiceAccountKey(await Bun.file(keyPath).text().catch(() => ''))
if ('error' in parsed) {
  log(`error: ${parsed.error}`)
  process.exit(1)
}

const sql = connect()
const site = await requireSite(sql, siteId)
log(`import-ga4 → "${site.name}" (${siteId})  property ${property}${dryRun ? '  [dry-run]' : ''}`)
log('asking Google for the property history (this can take a minute on a long history)…')

let history
try {
  history = await fetchGa4History({
    propertyId: property,
    key: parsed.key,
    startDate: args.from as string | undefined,
    endDate: args.to as string | undefined,
  })
}
catch (err) {
  // The message is already redacted by ga4.ts; this is the last place it could
  // reach a terminal or a CI log.
  log(`error: ${(err as Error).message}`)
  await sql.end()
  process.exit(1)
}

log(`Google returned ${history.rowCount} rows; ${history.records.length} usable (${history.skipped} without a usable date or view count).`)
// Never silent. A partial import that reports success is worse than a failure,
// because the missing history looks like a traffic drop that never happened.
if (history.truncated)
  log('WARNING: the property has more rows than this importer will page through. The import is PARTIAL — narrow it with --from/--to and run it again per period.')
if (history.other)
  log(`WARNING: Google bucketed ${history.other} rows into "(other)" because the property exceeds its cardinality limits. That traffic is NOT imported — it cannot be attributed to a real page or source. Import shorter periods to reduce it.`)

if (replace && !dryRun) {
  const d1 = await sql`DELETE FROM page_views WHERE site_id = ${siteId} AND id LIKE ${`${GA_PAGE_VIEW_PREFIX}%`}`
  const d2 = await sql`DELETE FROM sessions WHERE site_id = ${siteId} AND id LIKE ${`${GA_SESSION_PREFIX}%`}`
  log(`--replace: removed ${d1.count ?? 0} prior imported page_views, ${d2.count ?? 0} sessions`)
}

const now = new Date()
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

for (const record of history.records) {
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
  ? `dry-run: would import ~${totalPv} page_views / ${totalSess} sessions from ${history.records.length} GA rows (nothing written)`
  : `done: imported ${totalPv} page_views / ${totalSess} sessions from ${history.records.length} GA rows`)

await sql.end()
