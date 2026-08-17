/**
 * Import Search Console performance data — which searches bring people here.
 *
 *   bun scripts/analytics/import-search-console.ts \
 *     --site=<analyticshq-site-id> --property=<sc-domain:example.com> \
 *     --key=<service-account.json> \
 *     [--from=2025-01-01] [--to=2026-07-01] [--replace] [--dry-run]
 *
 * ## Getting the credential
 *
 * In the Google Cloud project of your choosing: create a service account,
 * download its JSON key, and enable the Search Console API. Then in Search
 * Console go to Settings → Users and permissions and add the service account's
 * email as a user with Full or Restricted access.
 *
 * Being an owner of the property yourself is NOT enough — the service account
 * needs its own grant. That single step is the one people miss, and it presents
 * as a 403 that reads like a Google account problem.
 *
 * We register no application with Google — see app/Analytics/google-auth.ts for
 * why this rather than OAuth. The key is read, used for one token exchange, and
 * never stored or printed.
 *
 * ## Which property identifier
 *
 * A domain property is "sc-domain:example.com". A URL-prefix property is the
 * full URL including the trailing slash, "https://example.com/". They are
 * different properties with different data, and the API 404s on a mismatch. A
 * bare hostname is treated as a domain property.
 *
 * ## What arrives
 *
 * One row per day per query per page: clicks, impressions and average position.
 * No visitor dimension exists in the API and none is stored. Queries made by too
 * few people are withheld by Google before we see them, and the count of those
 * is reported rather than quietly dropped.
 */
import {
  buildSearchInsert,
  fetchSearchConsoleHistory,
  normalizeSiteUrl,
  searchImportWarnings,
  searchRowId,
} from '../../app/Analytics/search-console'
import { parseServiceAccountKey } from '../../app/Analytics/google-auth'
import { connect, log, parseArgs, requireArg, requireSite } from './lib'

const USAGE = 'usage: import-search-console --site=<analyticshq-id> --property=<sc-domain:example.com> --key=<service-account.json> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--replace] [--dry-run]'
const args = parseArgs()
const siteId = requireArg(args, 'site', USAGE)
const property = requireArg(args, 'property', USAGE)
const keyPath = requireArg(args, 'key', USAGE)
const dryRun = args['dry-run'] === true
const replace = args.replace === true

const normalized = normalizeSiteUrl(property)
if (!normalized) {
  log('error: that is not a Search Console property. Use "sc-domain:example.com" for a domain property, or the full URL including the trailing slash for a URL-prefix property.')
  process.exit(1)
}

const parsed = parseServiceAccountKey(await Bun.file(keyPath).text().catch(() => ''))
if ('error' in parsed) {
  log(`error: ${parsed.error}`)
  process.exit(1)
}

const sql = connect()
const site = await requireSite(sql, siteId)
log(`import-search-console → "${site.name}" (${siteId})  property ${normalized}${dryRun ? '  [dry-run]' : ''}`)
log('asking Google for the search performance history…')

let history
try {
  history = await fetchSearchConsoleHistory({
    siteUrl: normalized,
    key: parsed.key,
    startDate: args.from as string | undefined,
    endDate: args.to as string | undefined,
  })
}
catch (err) {
  log(`error: ${(err as Error).message}`)
  await sql.end()
  process.exit(1)
}

log(`Google returned ${history.rowCount} rows; ${history.records.length} usable.`)
// Never silent. A partial import that reports success is worse than a failure.
for (const warning of searchImportWarnings({
  truncated: history.truncated,
  anonymized: history.anonymized,
  skipped: history.skipped,
}))
  log(`WARNING: ${warning}`)

if (replace && !dryRun) {
  const deleted = await sql`DELETE FROM search_queries WHERE site_id = ${siteId}`
  log(`--replace: removed ${deleted.count ?? 0} prior search rows`)
}

let written = 0
let buffer: Record<string, unknown>[] = []

async function flush(): Promise<void> {
  if (dryRun) { buffer = []; return }
  const stmt = buildSearchInsert(buffer)
  if (stmt)
    await sql.unsafe(stmt.sql, stmt.params)
  buffer = []
}

for (const record of history.records) {
  buffer.push({
    id: await searchRowId(siteId, record),
    site_id: siteId,
    date: record.date,
    query: record.query,
    path: record.path,
    clicks: record.clicks,
    impressions: record.impressions,
    position: record.position,
  })
  written++
  if (buffer.length >= 1000)
    await flush()
}
await flush()

log(dryRun
  ? `dry-run: would import ${written} search rows (nothing written)`
  : `done: imported ${written} search rows`)

await sql.end()
