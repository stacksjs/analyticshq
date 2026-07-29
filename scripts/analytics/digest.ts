/**
 * Weekly (or N-day) digest for a site — the data behind email summaries.
 *
 *   bun scripts/analytics/digest.ts --site=<id> [--days=7] [--format=json|text]
 *
 * Computes the headline numbers for the period and their change vs. the prior
 * period of the same length, plus top pages and sources. Prints to stdout so it
 * can be piped, mailed, or (later) rendered into a scheduled email. Read-only.
 */
import { connect, isoStamp, log, parseArgs, pctChange, periodWindows, requireArg, requireSite } from './lib'

const args = parseArgs()
const USAGE = 'usage: digest --site=<id> [--days=7] [--format=json|text]'
const siteId = requireArg(args, 'site', USAGE)
const days = Math.max(1, Math.floor(Number(args.days) || 7))
const format = (args.format as string) || 'text'

const sql = connect()
await requireSite(sql, siteId)
const { curFrom, curTo, prevFrom, prevTo } = periodWindows(days)

/** Headline counts for a window. */
async function totals(from: string, to: string): Promise<{ visitors: number, views: number, sessions: number }> {
  const r = (await sql.unsafe(
    `SELECT COUNT(DISTINCT visitor_id)::int AS visitors, COUNT(*)::int AS views, COUNT(DISTINCT session_id)::int AS sessions
    FROM page_views WHERE site_id = $1 AND "timestamp" >= $2 AND "timestamp" <= $3`,
    [siteId, from, to],
  ))[0]
  return { visitors: r?.visitors ?? 0, views: r?.views ?? 0, sessions: r?.sessions ?? 0 }
}

async function top(column: string, from: string, to: string): Promise<{ name: string, views: number }[]> {
  return await sql.unsafe(
    `SELECT ${column} AS name, COUNT(*)::int AS views FROM page_views
    WHERE site_id = $1 AND "timestamp" >= $2 AND "timestamp" <= $3 AND ${column} IS NOT NULL AND ${column} <> ''
    GROUP BY ${column} ORDER BY views DESC LIMIT 5`,
    [siteId, from, to],
  )
}

const cur = await totals(curFrom, curTo)
const prev = await totals(prevFrom, prevTo)
const digest = {
  site: siteId,
  period: { days, from: curFrom, to: curTo },
  visitors: { value: cur.visitors, change: pctChange(cur.visitors, prev.visitors) },
  views: { value: cur.views, change: pctChange(cur.views, prev.views) },
  sessions: { value: cur.sessions, change: pctChange(cur.sessions, prev.sessions) },
  topPages: await top('path', curFrom, curTo),
  topSources: await top('referrer_source', curFrom, curTo),
  generatedAt: isoStamp(new Date()),
}

if (format === 'json') {
  process.stdout.write(`${JSON.stringify(digest, null, 2)}\n`)
}
else {
  const d = (c: number | null) => (c == null ? '—' : `${c >= 0 ? '+' : ''}${c}%`)
  log(`Digest for ${siteId} · last ${days} days`)
  log(`  Visitors ${cur.visitors} (${d(digest.visitors.change)})  Views ${cur.views} (${d(digest.views.change)})  Sessions ${cur.sessions} (${d(digest.sessions.change)})`)
  log(`  Top pages:   ${digest.topPages.map(p => `${p.name} (${p.views})`).join(', ') || '—'}`)
  log(`  Top sources: ${digest.topSources.map(s => `${s.name} (${s.views})`).join(', ') || '—'}`)
}

await sql.end()
