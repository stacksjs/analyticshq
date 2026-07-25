import type { SaasConfig } from '@stacksjs/types'

/**
 * **SaaS / billing plans**
 *
 * The **Free** tier is implicit: a user with no active subscription is on Free
 * (see the free-tier limits enforced in the ingest/creation paths). The **Pro**
 * plan below is pushed to Stripe by `createStripeProduct()` — `pricing[].key`
 * becomes the Stripe `lookup_key` the checkout resolves. Self-hosted
 * deployments leave the `STRIPE_*` env vars unset, so billing is inert and
 * every feature is unlocked.
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
