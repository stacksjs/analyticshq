/**
 * The first server-side plan check in this codebase, so these are the first
 * tests that a plan means anything at all.
 *
 * Two failure modes are worth more than the rest and are what most of this file
 * is about. One: a paying customer being told they are not. Two: two different
 * answers to "is this account paying" drifting apart, so the badge in the header
 * says Pro while the gate on the endpoint says otherwise — the exact divergence
 * a sibling app shipped.
 *
 * The database-backed resolution is not mocked, for the reason site-access.test.ts
 * gives. It is covered by source-level guarantees here about the SHAPE of the
 * queries, which is where both failure modes actually live.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  billingEnabled,
  DEFAULT_PLAN,
  isUnlimited,
  limitReachedMessage,
  PAID_PLAN,
  PLAN_LIMITS,
  SELF_HOSTED_LIMITS,
  SELF_HOSTED_PLAN,
} from '../../config/plans'

const ROOT = join(import.meta.dir, '../..')

/**
 * Source with comments removed.
 *
 * These files explain at length what they deliberately do NOT do — not consult
 * `ends_at`, not delegate to `manageSubscription.isValid()` — so a check for
 * their absence matches the explanation and fails on a correct file. Same false
 * positive no-third-party-assets.test.ts documents, and the same fix: match
 * code, not prose.
 */
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const entitlements = code('app/Analytics/entitlements.ts')
const meAction = code('app/Actions/MeAction.ts')

describe('the plan catalogue', () => {
  test('free cannot add anyone, pro is unbounded', () => {
    // The product decision, in one place: unlimited teammates included in Pro at
    // no per-seat charge, and a hard paywall on Free.
    expect(PLAN_LIMITS[DEFAULT_PLAN]!.teammates).toBe(0)
    expect(isUnlimited(PLAN_LIMITS[PAID_PLAN]!.teammates)).toBe(true)
  })

  test('every declared plan has every limit', () => {
    // A missing key reads as `undefined`, and `count >= undefined` is false —
    // so a typo here would silently unlock rather than deny.
    for (const [name, limits] of Object.entries(PLAN_LIMITS)) {
      expect({ name, teammates: typeof limits.teammates }).toEqual({ name, teammates: 'number' })
      expect(Number.isNaN(limits.teammates)).toBe(false)
    }
  })

  test('only enforced limits are declared', () => {
    // The pricing page also advertises 1 site, 10k events and 30-day retention
    // on Free. None are enforced anywhere, and listing them here would recreate
    // exactly what `plan` already was: scaffolding that reads as a feature.
    for (const limits of Object.values(PLAN_LIMITS))
      expect(Object.keys(limits)).toEqual(['teammates'])
  })

  test('self-hosted is unlimited', () => {
    expect(isUnlimited(SELF_HOSTED_LIMITS.teammates)).toBe(true)
    expect(SELF_HOSTED_PLAN).not.toBe(DEFAULT_PLAN)
  })

  test('isUnlimited is true only for a genuinely unbounded value', () => {
    expect(isUnlimited(Number.POSITIVE_INFINITY)).toBe(true)
    expect(isUnlimited(0)).toBe(false)
    expect(isUnlimited(100)).toBe(false)
    // NaN is not "unlimited"; it is a bug, and treating it as unlimited would
    // turn a bad limit into an open door.
    expect(isUnlimited(Number.NaN)).toBe(false)
  })
})

describe('billingEnabled', () => {
  const saved = process.env.STRIPE_SECRET_KEY

  test('is false with no Stripe key, which is the self-hosted signal', () => {
    delete process.env.STRIPE_SECRET_KEY
    try {
      expect(billingEnabled()).toBe(false)
    }
    finally {
      if (saved !== undefined)
        process.env.STRIPE_SECRET_KEY = saved
    }
  })

  test('is false for an empty key, not merely an absent one', () => {
    process.env.STRIPE_SECRET_KEY = ''
    try {
      expect(billingEnabled()).toBe(false)
    }
    finally {
      if (saved !== undefined)
        process.env.STRIPE_SECRET_KEY = saved
    }
  })

  test('is true once a key is set', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_anything'
    try {
      expect(billingEnabled()).toBe(true)
    }
    finally {
      if (saved !== undefined)
        process.env.STRIPE_SECRET_KEY = saved
    }
  })

  test('tests/setup.ts leaves billing on, so the gates are live in this suite', () => {
    // Worth asserting rather than discovering: a suite running with gating off
    // would never exercise the paywall, and a test that wants past a gate has to
    // make the site's owner Pro rather than assuming it is free.
    expect(billingEnabled()).toBe(true)
  })
})

describe('limitReachedMessage', () => {
  test('sells the upgrade on the free plan', () => {
    const msg = limitReachedMessage('teammates', 0, DEFAULT_PLAN)
    expect(msg).toMatch(/Pro/)
  })

  test('does not pretend there is a higher tier on the paid one', () => {
    // There is nothing above Pro to upgrade to, so it points at the two real
    // escape hatches instead of inventing one.
    const msg = limitReachedMessage('teammates', 100, PAID_PLAN)
    expect(msg).not.toMatch(/Upgrade to/)
    expect(msg).toMatch(/self-host|contact/i)
  })

  test('names the resource and the limit', () => {
    expect(limitReachedMessage('teammates', 100, PAID_PLAN)).toContain('100')
    expect(limitReachedMessage('teammates', 100, PAID_PLAN)).toContain('teammates')
  })
})

describe('how "is this account paying" is resolved', () => {
  test('the query asks for an active-or-trialing row directly', () => {
    // NOT "read the first row, then check its status". The webhook upserts by
    // provider_id, so a customer who cancels and resubscribes has two
    // type='default' rows — one canceled, one active — and an unordered LIMIT 1
    // can return the canceled one. They pay and stay un-upgraded. The framework's
    // manageSubscription.isValid() has exactly that shape, which is why this
    // does not delegate to it.
    expect(entitlements).toContain(`provider_status IN ('active', 'trialing')`)
    expect(entitlements).not.toContain('manageSubscription')
    expect(entitlements).not.toContain('hasActiveSubscription')
  })

  test('ends_at is deliberately not consulted', () => {
    // Stripe sets it when a subscription will stop at the end of a paid period
    // while provider_status stays active until it actually does. Treating a
    // future ends_at as unpaid would cut someone off from a period they bought.
    expect(entitlements).not.toContain('ends_at')
  })

  test('/api/me answers from the same function as the gates', () => {
    // Two definitions is how a billing page ends up saying Free while the
    // enforcement says Pro.
    expect(meAction).toContain('userIsPro')
    expect(meAction).not.toContain('hasActiveSubscription')
  })

  test('a site resolves its plan from its OWNER', () => {
    // An agency admin manages client sites they do not own; billing the caller
    // would mean a freelancer needs Pro to work on a client's paid site.
    expect(entitlements).toContain('siteOwnerId')
    expect(entitlements).toMatch(/SELECT owner_id FROM sites/)
  })

  test('self-hosted short-circuits before any query', () => {
    const fn = entitlements.slice(entitlements.indexOf('export async function planForSite'))
    const guard = fn.indexOf('billingEnabled()')
    const firstQuery = fn.indexOf('siteOwnerId(')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(firstQuery)
  })

  test('every incomplete path degrades to free, never to unlimited', () => {
    // A site mid-checkout, an ownerless shadow row created by /collect, or a
    // database hiccup must be free-tier — not broken, and not unlimited.
    const fn = entitlements.slice(entitlements.indexOf('export async function planForSite'))
    expect(fn).toContain('DEFAULT_PLAN')
    expect(fn).not.toContain('SELF_HOSTED_LIMITS\n')
    expect(entitlements).toContain('.catch(() => [])')
  })
})
