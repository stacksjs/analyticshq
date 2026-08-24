/**
 * Which plan a site is on, and therefore what may be done to it.
 *
 * This is the companion to `access.ts`. That file answers "is this person
 * allowed" — an edge between a user and a site. This one answers "is this site
 * paid for", which is a property of the site's OWNER, not of whoever happens to
 * be asking.
 *
 * ## Why the owner and not the caller
 *
 * An agency admin manages a dozen client sites they do not own. Billing the
 * admin's own subscription would mean a freelancer needs Pro to work on a
 * client's paid site, and a client's paid site would stop working the moment
 * the freelancer's card expired. The site's owner is who bought it, so the
 * owner's subscription is what the site is entitled to. The plan catalogue
 * lives in `config/plans.ts`; the resolution is here because it touches the
 * database and `config/` should not.
 *
 * ## The single definition of "is this user paying"
 *
 * `userIsPro()` is it. `/api/me` reports the same function's answer, so the
 * badge in the header and the gate on the endpoint cannot disagree — which is
 * the exact failure mode a sibling app shipped, where the billing page read
 * `provider_status` and the enforcement did not, so a canceled subscription
 * kept its paid limits while the page said "Free".
 */

import { db } from '@stacksjs/database'
import { DEFAULT_PLAN, PAID_PLAN, PLAN_LIMITS, SELF_HOSTED_LIMITS, SELF_HOSTED_PLAN, billingEnabled, type PlanLimits } from '../../config/plans'

export interface ResolvedPlan {
  /** `self-hosted` | `free` | `pro`. Carried alongside the limits so an error can name it. */
  plan: string
  limits: PlanLimits
}

/**
 * Does this user have a subscription that is currently paying?
 *
 * Asks the database for an active-or-trialing row directly rather than reading
 * whichever row comes back first and then inspecting it. That ordering matters:
 * the webhook upserts by `provider_id`, so a customer who cancels and later
 * resubscribes ends up with TWO `type = 'default'` rows — one canceled, one
 * active — and an unordered `LIMIT 1` can return the canceled one. The
 * framework's own `manageSubscription.isValid()` has exactly that shape, which
 * is why this does not delegate to it.
 *
 * `ends_at` is deliberately NOT consulted. Stripe sets it when a subscription
 * is scheduled to stop at the end of a paid period, while `provider_status`
 * stays `active` until that moment actually arrives and the webhook flips it to
 * `canceled`. Treating a future `ends_at` as "not paying" would cut someone off
 * from the period they already paid for.
 */
export async function userIsPro(userId: string | number | null | undefined): Promise<boolean> {
  const uid = Number(userId)
  if (!Number.isFinite(uid))
    return false

  const rows = await db.unsafe(
    `SELECT 1 FROM subscriptions
     WHERE user_id = $1
       AND type = 'default'
       AND provider_status IN ('active', 'trialing')
     LIMIT 1`,
    [uid],
  ).catch(() => []) as unknown[]

  return (rows?.length ?? 0) > 0
}

/** The user id in `sites.owner_id`, or null for an unknown or ownerless site. */
export async function siteOwnerId(siteId: string): Promise<number | null> {
  const rows = await db.unsafe(
    `SELECT owner_id FROM sites WHERE id = $1 LIMIT 1`,
    [String(siteId)],
  ).catch(() => []) as Array<{ owner_id: number | null }>

  const owner = rows?.[0]?.owner_id
  return owner == null ? null : Number(owner)
}

/**
 * The plan a site is entitled to.
 *
 * Every incomplete path degrades to Free rather than throwing or unlocking: a
 * site mid-checkout, an ownerless shadow row created by `/collect`, or a
 * database hiccup is free-tier, not broken and not unlimited. The one exception
 * is a self-hosted install, which is checked first and short-circuits before
 * any query.
 */
export async function planForSite(siteId: string): Promise<ResolvedPlan> {
  if (!billingEnabled())
    return { plan: SELF_HOSTED_PLAN, limits: SELF_HOSTED_LIMITS }

  const ownerId = await siteOwnerId(siteId)
  if (ownerId == null)
    return { plan: DEFAULT_PLAN, limits: PLAN_LIMITS[DEFAULT_PLAN]! }

  const pro = await userIsPro(ownerId)
  const plan = pro ? PAID_PLAN : DEFAULT_PLAN
  return { plan, limits: PLAN_LIMITS[plan]! }
}

/** Convenience for the common question. */
export async function siteIsPro(siteId: string): Promise<boolean> {
  return (await planForSite(siteId)).plan !== DEFAULT_PLAN
}
