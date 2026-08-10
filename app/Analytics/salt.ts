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
 * ## Concurrency
 *
 * Two beacons for a new site-day race to create the salt. The insert is
 * `ON CONFLICT DO NOTHING` followed by a read, so the loser adopts the winner's
 * value rather than overwriting it — if both wrote, the same visitor would hash
 * two ways and be counted twice.
 */

import { randomBytes } from 'node:crypto'
import { db } from '@stacksjs/database'

/** How many days of salts to keep. */
const RETENTION_DAYS = 2

const cache = new Map<string, string>()

/** UTC calendar day as `YYYY-MM-DD`. */
export function saltDateFor(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10)
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
  const saltDate = saltDateFor(date)
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
 * mapping is merely secret; once it is gone the day's hashes cannot be tied back
 * to any input at all. Two days rather than one so events that arrive just after
 * UTC midnight still hash consistently.
 */
export async function purgeExpiredSalts(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const cutoffDate = saltDateFor(cutoff)

  for (const key of [...cache.keys()]) {
    const saltDate = key.slice(key.lastIndexOf(':') + 1)
    if (saltDate < cutoffDate)
      cache.delete(key)
  }

  try {
    await db.unsafe('DELETE FROM visitor_salts WHERE salt_date < $1', [cutoffDate])
  }
  catch {
    return 0
  }
  return 1
}
