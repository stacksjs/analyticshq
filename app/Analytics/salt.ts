/**
 * Per-site, per-day secret salt for the cookieless visitor hash (#9).
 *
 * ## Why a secret at all
 *
 * The salt was the plain UTC date. Because it is public, the only unknown in
 * `sha256(ip | ua | siteId | salt)` was the IP — so the digest worked as a
 * **confirmation oracle**: anyone holding a stored visitor id could take a
 * candidate IP and User-Agent, compute the hash, and learn whether that person
 * visited the site that day. Not storing the raw IP does not prevent that; the
 * whole input space is small and guessable.
 *
 * A random 32-byte secret removes the last known term. And once the row is
 * deleted at the end of the retention window, the day's hashes are permanently
 * unlinkable to any input, by anyone, including us.
 *
 * ## Why it is cached in-process
 *
 * `/collect` is the hot path — one call per page view. A database round-trip per
 * beacon to fetch a value that changes once a day would be the wrong trade, so
 * the salt is memoised per `site:date`. The cache is small (one entry per active
 * site per day) and self-evicting.
 *
 * ## Windows longer than a day
 *
 * A site whose owner turns on visitor timelines keeps one salt for a whole
 * window instead of one day (`sites.visitor_window_days`, at most
 * `privacy.maxVisitorWindowDays`, 30). The same visitor then hashes to the same
 * id for the rest of that window, which is what lets the dashboard show one
 * person's visits over several days.
 *
 * Windows are fixed blocks of the calendar, counted from the Unix epoch, not
 * rolling from each visitor's first visit. So an id can never be carried past
 * the end of its block, and every salt has a known end. The row is keyed by the
 * block's first day, which for a 1-day window is just the day, so the ids of
 * every site that never opted in are exactly what they were.
 *
 * The purge deletes a salt once its block is over, per site. Turning timelines
 * off shortens a site's window back to 1, and the next purge then deletes the
 * long salt, so turning it off ends the linkage rather than waiting it out.
 *
 * ## Concurrency
 *
 * Two beacons for a new site-day race to create the salt. The insert is
 * `ON CONFLICT DO NOTHING` followed by a read, so the loser adopts the winner's
 * value rather than overwriting it — if both wrote, the same visitor would hash
 * two ways and be counted twice.
 */

import { randomBytes } from 'node:crypto'
import { db } from '@stacksjs/database'
import privacy from '../../config/privacy'
import { purgeSaltsQuery } from './salt-purge'

const cache = new Map<string, string>()

const DAY_MS = 24 * 60 * 60 * 1000

/** UTC calendar day as `YYYY-MM-DD`. */
export function saltDateFor(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

/**
 * A usable window length: a whole number of days from 1 to the install's
 * ceiling. Anything else is 1, so a bad value shortens linkage rather than
 * lengthening it.
 */
export function clampWindowDays(days: unknown, max: number = privacy.maxVisitorWindowDays): number {
  const n = Number(days)
  if (!Number.isInteger(n) || n < 1)
    return 1
  return Math.min(n, Math.max(1, max))
}

/**
 * The first day of the fixed block `date` falls in, as `YYYY-MM-DD`. Blocks are
 * counted from the Unix epoch, so every site with the same window shares the
 * same boundaries, and a 1-day window is just the day itself.
 */
export function windowStartFor(date: Date = new Date(), windowDays: number = 1): string {
  const days = clampWindowDays(windowDays)
  const index = Math.floor(date.getTime() / DAY_MS)
  return saltDateFor(new Date((index - (index % days)) * DAY_MS))
}

function cacheKey(siteId: string, saltDate: string): string {
  return `${siteId}:${saltDate}`
}

/** Test seam — the cache would otherwise leak state between cases. */
export function clearSaltCache(): void {
  cache.clear()
}

/**
 * The secret salt for one site on one UTC day, creating it on first use.
 *
 * Returns a fresh random value if the database is unreachable rather than
 * throwing: losing a beacon is better than 500ing the tracker, and a
 * throwaway salt degrades to "this visitor is counted as new", never to a
 * weaker hash. Deliberately NOT falling back to the date string, which would
 * silently reinstate the oracle this exists to remove.
 */
export async function getDailySalt(siteId: string, date: Date = new Date()): Promise<string> {
  return getVisitorSalt(siteId, 1, date)
}

/**
 * The secret salt for one site's current window, creating it on first use. A
 * 1-day window is `getDailySalt`. Same failure behaviour: a throwaway random
 * value, never anything derivable.
 */
export async function getVisitorSalt(siteId: string, windowDays: number, date: Date = new Date()): Promise<string> {
  const saltDate = windowStartFor(date, windowDays)
  const key = cacheKey(siteId, saltDate)

  const cached = cache.get(key)
  if (cached)
    return cached

  const salt = randomBytes(32).toString('hex')

  try {
    // Loser of the race adopts the winner's row: two salts for one site-day
    // would split a single visitor into two.
    await db.unsafe(
      'INSERT INTO visitor_salts (site_id, salt_date, salt, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (site_id, salt_date) DO NOTHING',
      [siteId, saltDate, salt, new Date().toISOString()],
    )

    const rows = await db.unsafe(
      'SELECT salt FROM visitor_salts WHERE site_id = $1 AND salt_date = $2',
      [siteId, saltDate],
    ) as Array<{ salt: string }>

    const stored = rows?.[0]?.salt
    if (stored) {
      cache.set(key, stored)
      return stored
    }
  }
  catch {
    // Fall through to the in-memory value below.
  }

  cache.set(key, salt)
  return salt
}

/**
 * Drop salts past the retention window, and forget them locally.
 *
 * This is the part that makes the privacy claim true: while the row exists the
 * mapping is merely secret; once it is gone the window's hashes cannot be tied
 * back to any input at all. A salt is kept for its window plus
 * `saltRetentionDays - 1` days, so events that arrive just after the window
 * rolls over still hash consistently. For a 1-day window that is today and
 * yesterday, as it always was.
 *
 * The window is read from each salt's site as it is NOW, so a site that turned
 * timelines off loses its long salt on the next run. A salt whose site no
 * longer exists is treated as a 1-day one.
 */
export async function purgeExpiredSalts(now: Date = new Date()): Promise<number> {
  // The local cache holds a single process's salts. Anything older than the
  // longest possible window is dropped here, and the database is the authority
  // for the rest: a salt deleted there is re-read on the next miss.
  const longest = new Date(now.getTime() - (privacy.maxVisitorWindowDays - 1 + privacy.saltRetentionDays) * DAY_MS)
  const longestCutoff = saltDateFor(longest)
  const dailyCutoff = saltDateFor(new Date(now.getTime() - privacy.saltRetentionDays * DAY_MS))
  for (const key of [...cache.keys()]) {
    const saltDate = key.slice(key.lastIndexOf(':') + 1)
    if (saltDate < longestCutoff)
      cache.delete(key)
  }

  try {
    const { sql, params } = purgeSaltsQuery(now, privacy.saltRetentionDays, privacy.maxVisitorWindowDays)
    await db.unsafe(sql, params)
  }
  catch {
    return 0
  }
  // Every cached salt older than a day's retention belongs to a long window.
  // Drop them too, so a site that just turned timelines off stops hashing with
  // its long salt on this process as soon as the row is gone.
  for (const key of [...cache.keys()]) {
    const saltDate = key.slice(key.lastIndexOf(':') + 1)
    if (saltDate < dailyCutoff)
      cache.delete(key)
  }
  return 1
}
