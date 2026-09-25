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
 * ## Platform admins
 *
 * One more source of rank, and it is not per site: `users.is_platform_admin`.
 * A platform admin runs the install. They hold `admin` on every site, owned or
 * not, and the site list shows them every site rather than the ones they were
 * invited to. They do not hold `owner` on sites that are not theirs, so deleting
 * a customer's site or its data still takes the customer.
 *
 * The flag is a column, never an email match. Registration does not verify
 * addresses, so "whoever signs up as cloud@stacksjs.com is an admin" would hand
 * the install to the first person to type it. Migration 56 grants the flag to
 * the account that already holds that address, and `scripts/account.ts
 * --grant-admin` is the only other way to set it. The User model does not list
 * it as fillable, so no request body can.
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

/** Postgres hands booleans back as `true`, but a raw driver may say `'t'` or `1`. */
function pgTrue(value: unknown): boolean {
  return value === true || value === 't' || value === 1 || value === '1'
}

/**
 * The rank a user holds from all three sources, highest first.
 *
 * Pure, so the ordering is tested without a database. An owner stays owner
 * whatever else is true. A platform admin with a viewer membership is still
 * an admin, and one with no membership at all is too.
 */
export function effectiveRole(input: { owner: boolean, member: SiteRole | null, platformAdmin: boolean }): SiteRole | null {
  if (input.owner)
    return 'owner'
  if (input.platformAdmin)
    return 'admin'
  return input.member
}

/** Whether this user runs the install and so reaches every site. */
export async function isPlatformAdmin(userId: string | number | null | undefined): Promise<boolean> {
  const uid = Number(userId)
  if (userId == null || !Number.isFinite(uid))
    return false
  const rows = await db.unsafe(`SELECT is_platform_admin FROM users WHERE id = $1 LIMIT 1`, [uid])
    .catch(() => []) as Array<{ is_platform_admin: unknown }>
  return pgTrue(rows?.[0]?.is_platform_admin)
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
  // Asked separately rather than joined in, and only when it could change the
  // answer. A join would make every owner's access depend on the users column
  // existing, so one missed migration would lock every customer out of their
  // own site. This way the worst a missing column does is fail closed for admins.
  const platformAdmin = !owner && member !== 'admin' && await isPlatformAdmin(uid)

  return effectiveRole({ owner, member, platformAdmin })
}

/** One row of a user's site list. `owner_email` is filled in for platform admins only. */
export interface ReachableSite {
  id: string
  name: string
  domains: unknown
  timezone: string | null
  currency: string | null
  is_active: unknown
  created_at: unknown
  role: SiteRole
  owner_email?: string | null
}

/**
 * Every site this user can open, with their role on each, newest first.
 *
 * The one answer to "which sites can I reach". GET /api/sites and the
 * dashboard's switcher both read it, because two copies of this query that
 * disagreed is how an invited member once authenticated fine and still saw an
 * empty switcher (#19).
 *
 * A platform admin gets every site on the install with no filter, including
 * sites nobody has claimed yet (rows /collect registered on first sight of an
 * id), and each row names its owner so the list is readable. Everyone else gets
 * the sites they own or were invited to and never learns who owns the others.
 */
export async function listReachableSites(userId: string | number): Promise<{ platformAdmin: boolean, sites: ReachableSite[] }> {
  const uid = Number(userId)
  if (!Number.isFinite(uid))
    return { platformAdmin: false, sites: [] }

  const platformAdmin = await isPlatformAdmin(uid)
  const columns = `s.id, s.name, s.domains, s.timezone, s.currency, s.is_active, s.created_at`

  const rows = platformAdmin
    ? await db.unsafe(
        `SELECT ${columns},
                CASE WHEN s.owner_id = $1 THEN 'owner' ELSE 'admin' END AS role,
                o.email AS owner_email
         FROM sites s
         LEFT JOIN users o ON o.id = s.owner_id
         ORDER BY (s.owner_id IS NULL), s.created_at DESC NULLS LAST, s.id`,
        [uid],
      )
    : await db.unsafe(
        `SELECT ${columns},
                CASE WHEN s.owner_id = $1 THEN 'owner' ELSE m.role END AS role
         FROM sites s
         LEFT JOIN site_members m ON m.site_id = s.id AND m.user_id = $1
         WHERE s.owner_id = $1 OR m.user_id IS NOT NULL
         ORDER BY s.created_at DESC NULLS LAST, s.id`,
        [uid],
      )

  return { platformAdmin, sites: (rows ?? []) as ReachableSite[] }
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
