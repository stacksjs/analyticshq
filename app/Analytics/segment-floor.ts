/**
 * The disclosure floor for one site.
 *
 * `privacy.minSegmentSize` (5 by default, `ANALYTICSHQ_MIN_SEGMENT_SIZE`) is the
 * install's floor: a filtered report whose population is under it is withheld,
 * a region or city with fewer visitors is folded into "Other", and a web vital
 * with fewer samples reads n/a. It is right for a customer's site, where the
 * visitors are strangers to whoever reads the dashboard.
 *
 * It is not always right for the operator's own site. On a personal site with a
 * few dozen visitors a day, a floor of 5 folds every city into "Other" and the
 * report says nothing. So a site can carry its own floor in
 * `sites.settings.min_segment_size`, and 0 turns it off for that site alone.
 *
 * Only an operator sets it (`scripts/account.ts --segment-size`). No endpoint
 * writes that key: PATCH /api/sites/{id} only writes the settings keys it names,
 * and this is not one of them, so an owner cannot lower the floor that protects
 * their own visitors from the dashboard.
 *
 * Anything that is not a non-negative integer reads as "no override" rather than
 * as 0, so a malformed value keeps the install's floor instead of switching the
 * guard off.
 */

import { db } from '@stacksjs/database'
import privacy from '../../config/privacy'

/** The settings key the override lives under. */
export const SITE_FLOOR_KEY = 'min_segment_size'

/** The override in `settings` when it is a valid one, else the install's floor. */
export function resolveMinSegmentSize(settings: unknown, installDefault: number): number {
  const raw = (settings && typeof settings === 'object') ? (settings as Record<string, unknown>)[SITE_FLOOR_KEY] : undefined
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0)
    return raw
  return installDefault
}

/** The floor that applies to this site's reports. */
export async function minSegmentSizeFor(siteId: string): Promise<number> {
  const rows = await db.unsafe(`SELECT settings FROM sites WHERE id = $1 LIMIT 1`, [String(siteId)])
    .catch(() => []) as Array<{ settings: string | null }>
  let settings: unknown = {}
  try {
    settings = JSON.parse(rows?.[0]?.settings || '{}')
  }
  catch {
    settings = {}
  }
  return resolveMinSegmentSize(settings, privacy.minSegmentSize)
}
