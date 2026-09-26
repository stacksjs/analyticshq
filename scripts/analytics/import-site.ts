/**
 * Restore a native NDJSON archive produced by export-site.ts.
 *
 *   bun scripts/analytics/import-site.ts --in=backup.ndjson [--site=<new-id>]
 *   cat backup.ndjson | bun scripts/analytics/import-site.ts
 *
 * Inserts every row back in FK-safe order with ON CONFLICT (id) DO NOTHING, so
 * re-running is idempotent and it won't clobber existing rows. Use it to restore
 * a backup or migrate a site to another database.
 *
 * --site=<new-id> re-homes the archive onto a different site id — a full CLONE:
 * `site_id` becomes the new id, the `sites` row takes the new id, and every other
 * row's id (plus its session_id / goal_id references) is prefixed so the clone is
 * independent and can coexist with the source in the same database.
 */
import { connect, log, parseArgs } from './lib'

const TABLES = ['sites', 'goals', 'sessions', 'page_views', 'custom_events', 'conversions'] as const

const args = parseArgs()
const inPath = args.in as string | undefined
const rehome = args.site as string | undefined

const sql = connect()

// Read the whole archive, bucket rows by table.
const text = inPath ? await Bun.file(inPath).text() : await Bun.stdin.text()
/** One archived row: column name to value, as export-site wrote it. */
type Row = Record<string, unknown>

const buckets: Record<string, Row[]> = Object.fromEntries(TABLES.map(t => [t, []]))
let bad = 0
for (const line of text.split('\n')) {
  if (!line.trim())
    continue
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  }
  catch {
    bad++
    continue
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    bad++
    continue
  }
  const row: Row = { ...parsed }
  const t = String(row._t)
  if (!buckets[t]) {
    bad++
    continue
  }
  delete row._t
  if (rehome) {
    // Full clone: site id becomes `rehome`; every other id (and its FK refs) is
    // prefixed so the clone is independent and can't collide with the source.
    const px = (id: unknown) => (id == null || id === '' ? id : `${rehome}__${id}`)
    if (t === 'sites') {
      row.id = rehome
    }
    else {
      row.site_id = rehome
      row.id = px(row.id)
      if ('session_id' in row)
        row.session_id = px(row.session_id)
      if ('goal_id' in row)
        row.goal_id = px(row.goal_id)
    }
  }
  buckets[t].push(row)
}
if (bad)
  log(`skipped ${bad} malformed / unknown-table lines`)

let total = 0
for (const table of TABLES) {
  const rows = buckets[table]
  if (!rows.length)
    continue
  let inserted = 0
  for (let i = 0; i < rows.length; i += 2000) {
    const batch = rows.slice(i, i + 2000)
    const res = await sql`INSERT INTO ${sql(table)} ${sql(batch)} ON CONFLICT (id) DO NOTHING`
    inserted += res.count ?? batch.length
  }
  total += inserted
  log(`  ${table}: ${inserted}/${rows.length} inserted (rest already present)`)
}

log(`restore complete: ${total} rows${rehome ? ` (re-homed onto "${rehome}")` : ''}`)
await sql.end()
