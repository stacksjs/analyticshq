import type { SaasConfig } from '@stacksjs/types'

/**
 * **SaaS / billing plans**
 *
 * The **Free** tier is implicit: a user with no active subscription is on Free.
 * What that actually costs it is in `config/plans.ts`, which is the only place
 * a limit is enforced — this file declares what to sell, not who may do what.
 *
 * ## Getting these into Stripe
 *
 *     ./buddy stripe:setup
 *
 * That reads the plans below and creates them, with `pricing[].key` becoming the
 * Stripe `lookup_key` that `CreateCheckoutAction` resolves. Naming the command
 * rather than the framework function it calls, because the function name is not
 * something you can run and this comment previously sent readers looking for a
 * call site that does not exist in this repo.
 *
 * Run it once per Stripe account. It is NOT idempotent today — a second run
 * duplicates the product and then fails on the duplicate `lookup_key`, and
 * `--dry-run` is accepted but creates real products regardless
 * (stacksjs/stacks#2359). Until that is fixed, check the Stripe dashboard before
 * re-running rather than after.
 *
 * Self-hosted deployments leave the `STRIPE_*` env vars unset, so billing is
 * inert and every feature is unlocked — see `billingEnabled()` in config/plans.ts.
 */
export default {
  plans: [
    {
      productName: 'analyticshq Pro',
      description: 'Unlimited sites and events, full retention, and priority support.',
      pricing: [
        { key: 'analyticshq_pro_monthly', price: 1900, interval: 'month', currency: 'usd' },
        { key: 'analyticshq_pro_yearly', price: 19000, interval: 'year', currency: 'usd' },
      ],
      metadata: { createdBy: 'analyticshq', version: '1.0.0' },
    },
  ],
} satisfies SaasConfig
