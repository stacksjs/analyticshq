/**
 * What each plan is allowed to do.
 *
 * Until now `plan` existed only as a word: the webhook wrote `'pro'` onto a
 * subscription row, `/api/me` reported it, and the dashboard swapped a badge.
 * Nothing anywhere was denied to anyone. This file is where a plan starts
 * meaning something, and it is deliberately the ONLY place that defines it —
 * every gate imports from here rather than re-deriving "are they paying",
 * because two copies of that question is how a billing page ends up saying
 * "Free" while the enforcement says "Pro".
 *
 * ## Only enforced limits live here
 *
 * The pricing page also advertises 1 site, 10k events/month and 30-day
 * retention on Free. None of those are enforced anywhere today, and none are
 * listed below. Declaring a limit nothing reads is what `plan` already was —
 * scaffolding that reads as a feature. Add each one here when the code that
 * enforces it lands, not before.
 */

/** Caps a plan imposes. One entry per limit that is actually enforced. */
export interface PlanLimits {
  /**
   * How many people the owner may grant access to, beyond themselves.
   * `Infinity` is the unlimited sentinel, so every `count >= limit` comparison
   * works without special-casing.
   */
  teammates: number
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { teammates: 0 },
  pro: { teammates: Number.POSITIVE_INFINITY },
}

/** A user with no active subscription is on this. */
export const DEFAULT_PLAN = 'free'

/** The one paid plan, named once so checkout, webhook and gates cannot drift. */
export const PAID_PLAN = 'pro'

/**
 * Self-hosted installs leave Stripe unconfigured. They have nothing to upgrade
 * *to*, and the marketing site promises "self-hosting is free forever" — so the
 * whole tiering system goes inert rather than paywalling someone running their
 * own copy. See `billingEnabled()`.
 */
export const SELF_HOSTED_PLAN = 'self-hosted'
export const SELF_HOSTED_LIMITS: PlanLimits = { teammates: Number.POSITIVE_INFINITY }

/**
 * Is this the hosted service that actually charges?
 *
 * A Stripe secret key is the single signal. Read from `process.env` rather than
 * the resolved config to stay free of import-order hazards — `config/env.ts`
 * declares the same variable with a `''` default, so the two agree.
 *
 * Note for tests: `tests/setup.ts` sets a fake `STRIPE_SECRET_KEY` so the
 * payments module can boot, which means billing is ENABLED across the suite and
 * plan gates are live. That is deliberate — a suite that runs with gating off
 * would never exercise the paywall — but it does mean a test that wants to get
 * past a gate has to make the site's owner Pro rather than assuming it is free.
 */
export function billingEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

/** True for a limit that is not actually bounded. */
export function isUnlimited(value: number): boolean {
  return !Number.isFinite(value)
}

/**
 * What to tell someone who just hit a wall.
 *
 * On the top plan there is no higher tier to sell, so it says the honest thing
 * instead of "upgrade" — analyticshq is open source, and self-hosting is a real
 * answer we already advertise on the pricing page.
 */
export function limitReachedMessage(resource: string, limit: number, plan: string): string {
  if (plan === PAID_PLAN) {
    return `You have reached the Pro limit of ${limit} ${resource}. `
      + `analyticshq is open source — self-host for unlimited ${resource}, or contact us to raise it.`
  }
  return `Inviting ${resource} is a Pro feature. Upgrade to add people to this site.`
}
