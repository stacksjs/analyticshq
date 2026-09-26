/**
 * Export a site's raw analytics data.
 *
 *   bun scripts/analytics/export-site.ts --site=<id> [--out=file] [--format=ndjson|csv] [--table=page_views]
 *
 * Default (ndjson): a re-importable archive of every row for the site across
 * sites/goals/sessions/page_views/custom_events/conversions, one JSON object per
 * line tagged with `_t` (its table), in FK-safe order. Restore with import-site.ts.
 *
 * --format=csv --table=<name>: a single table as CSV (for spreadsheets).
 *
 * Writes to --out or stdout (NDJSON streams, so `… > backup.ndjson` works).
 */
import { connect, log, parseArgs, requireArg, requireSite } from './lib'

// FK-safe order: parents (sites, goals, sessions) before children.
const TABLES = ['sites', 'goals', 'sessions', 'page_views', 'custom_events', 'conversions'] as const
type Table = typeof TABLES[number]

/** One row as Postgres returns it: column name to value. */
type Row = Record<string, unknown>

function isTable(name: string): name is Table {
  return TABLES.some(t => t === name)
}
const USAGE = 'usage: export-site --site=<id> [--out=file] [--format=ndjson|csv] [--table=<name>]'

const args = parseArgs()
const siteId = requireArg(args, 'site', USAGE)
const format = (args.format as string) || 'ndjson'
const outPath = args.out as string | undefined

const sql = connect()
const site = await requireSite(sql, siteId)

// Keyset-paginate a table by its `id` PK so huge tables never load fully in memory.
async function* pages(table: Table, keyCol: 'id' | 'site_id', batch = 5000): AsyncGenerator<Row[]> {
  let last = ''
  for (;;) {
    const rows: Row[] = await sql.unsafe(
      `SELECT * FROM ${table} WHERE ${keyCol} = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [siteId, last, batch],
    )
    if (!rows.length)
      return
    yield rows
    last = String(rows[rows.length - 1].id)
    if (rows.length < batch)
      return
  }
}

const file = outPath ? Bun.file(outPath).writer() : null
const write = (s: string) => (file ? file.write(s) : process.stdout.write(s))

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

if (format === 'csv') {
  const table = requireArg(args, 'table', `csv export needs a single --table (one of: ${TABLES.join(', ')})`)
  if (!isTable(table)) {
    log(`error: unknown --table "${table}"`)
    process.exit(1)
  }
  const keyCol = table === 'sites' ? 'id' : 'site_id'
  let header = false
  let n = 0
  for await (const rows of pages(table, keyCol)) {
    if (!header && rows.length) {
      write(`${Object.keys(rows[0]).map(csvCell).join(',')}\n`)
      header = true
    }
    for (const r of rows) {
      write(`${Object.values(r).map(csvCell).join(',')}\n`)
      n++
    }
  }
  await file?.end()
  log(`exported ${n} ${table} rows for "${site.name}" (${siteId})`)
}
else if (format === 'ndjson') {
  const counts: Record<string, number> = {}
  for (const table of TABLES) {
    const keyCol = table === 'sites' ? 'id' : 'site_id'
    counts[table] = 0
    for await (const rows of pages(table, keyCol)) {
      for (const r of rows) {
        write(`${JSON.stringify({ _t: table, ...r })}\n`)
        counts[table]++
      }
    }
  }
  await file?.end()
  log(`exported "${site.name}" (${siteId}): ${TABLES.map(t => `${counts[t]} ${t}`).join(', ')}`)
}
else {
  log(`error: unknown --format "${format}" (use ndjson or csv)`)
  process.exit(1)
}

await sql.end()
