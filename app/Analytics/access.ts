/**
 * Who may do what to a site (#19).
 *
 * Every site-scoped endpoint used to call one function, `requireSiteOwner`, which
 * answered a single question: are you the row in `sites.owner_id`? That is the
 * right check for deleting a site and far too strict for reading its visitor
 * count, and it is why the product could not be sold to an agency.
 *
 * Three ranks, and the ordering is the whole design:
 *
 *   viewer  read the reports
 *   admin   the above, plus settings, goals, share links and members
 *   owner   the above, plus destroying things
 *
 * Owner is `sites.owner_id`, not a membership row — see the migration for why.
 * A user's effective rank is the higher of "owner of this site" and "their
 * membership row", so granting the owner an admin membership cannot demote them.
 *
 * ## The rule this file exists to enforce
 *
 * Site ids are public. They ride in the tracking snippet on every page of a
 * customer's site, which is exactly why `tests/unit/api-authz.test.ts` gates on
 * access rather than on knowing an id. Nothing here may ever treat possession of
 * a site id as evidence of anything.
 */

import { db } from '@stacksjs/database'

export type SiteRole = 'viewer' | 'admin' | 'owner'

/** Higher wins. Used for both the ordering and the membership/owner merge. */
const RANK: Record<SiteRole, number> = { viewer: 1, admin: 2, owner: 3 }

/** Roles a membership row may hold. Owner is not assignable — it is the site's. */
export const ASSIGNABLE_ROLES: readonly SiteRole[] = ['viewer', 'admin'] as const

export function isAssignableRole(value: unknown): value is SiteRole {
  return typeof value === 'string' && (ASSIGNABLE_ROLES as readonly string[]).includes(value)
}

/** Does `role` meet `required`? */
export function satisfies(role: SiteRole | null, required: SiteRole): boolean {
  return role != null && RANK[role] >= RANK[required]
}

/**
 * The user's effective role on a site, or null when they have no access.
 *
 * Returns null for a site that does not exist as well, so a caller cannot
 * distinguish "no such site" from "not yours" without a separate lookup — see
 * `siteExists` below, which callers use deliberately when a 404 is the honest
 * answer.
 */
export async function resolveSiteRole(userId: string | number, siteId: string): Promise<SiteRole | null> {
  const uid = Number(userId)
  if (!Number.isFinite(uid))
    return null

  const rows = await db.unsafe(
    `SELECT s.owner_id, m.role
     FROM sites s
     LEFT JOIN site_members m ON m.site_id = s.id AND m.user_id = $1
     WHERE s.id = $2 LIMIT 1`,
    [uid, String(siteId)],
  ).catch(() => []) as Array<{ owner_id: number | null, role: string | null }>

  const row = rows?.[0]
  if (!row)
    return null

  const owner = row.owner_id != null && Number(row.owner_id) === uid
  const member = isAssignableRole(row.role) ? row.role : null

  // The higher of the two. An owner who also holds a viewer membership row is
  // still the owner.
  if (owner)
    return 'owner'
  return member
}

/** Whether a site row exists at all, for callers that need to answer 404 vs 403. */
export async function siteExists(siteId: string): Promise<boolean> {
  const rows = await db.unsafe(`SELECT 1 FROM sites WHERE id = $1 LIMIT 1`, [String(siteId)])
    .catch(() => []) as unknown[]
  return (rows?.length ?? 0) > 0
}

/** Everyone who can reach a site, owner first. */
export async function listSiteMembers(siteId: string): Promise<Array<{ userId: number, email: string, name: string | null, role: SiteRole }>> {
  const rows = await db.unsafe(
    `SELECT u.id, u.email, u.name, 'owner' AS role, 0 AS sort
     FROM sites s JOIN users u ON u.id = s.owner_id WHERE s.id = $1
     UNION ALL
     SELECT u.id, u.email, u.name, m.role, 1 AS sort
     FROM site_members m JOIN users u ON u.id = m.user_id
     WHERE m.site_id = $1 AND u.id <> COALESCE((SELECT owner_id FROM sites WHERE id = $1), -1)
     ORDER BY sort, email`,
    [String(siteId)],
  ).catch(() => []) as Array<{ id: number, email: string, name: string | null, role: string }>

  return (rows ?? []).map(r => ({
    userId: Number(r.id),
    email: String(r.email),
    name: r.name ?? null,
    role: (r.role === 'owner' || isAssignableRole(r.role) ? r.role : 'viewer') as SiteRole,
  }))
}
