import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { config } from '@stacksjs/config'
import { getPrice } from '@stacksjs/payments'
import { response } from '@stacksjs/router'

/**
 * Start a Stripe Checkout session for the Pro plan (subscription mode) and
 * return its hosted URL. The client redirects the browser there. The price is
 * resolved from its Stripe `lookup_key` (see config/saas.ts), so no price id is
 * hard-coded. Requires an authenticated user.
 */
export default new Action({
  name: 'CreateCheckoutAction',
  description: 'Create a Stripe Checkout session for the Pro plan',
  method: 'POST',
  async handle(request: RequestInstance) {
    // The route runs the auth middleware, which stamps the user from either the
    // auth-token cookie (the pricing page's credentialed fetch) or a bearer token
    // (external API callers). request.user() returns whichever it resolved.
    const user = await request.user()
    if (!user)
      return response.unauthorized('Authentication required')

    const interval = request.get<unknown>('interval') === 'yearly' ? 'yearly' : 'monthly'
    const lookupKey = interval === 'yearly' ? 'analyticshq_pro_yearly' : 'analyticshq_pro_monthly'

    try {
      const price = await getPrice(lookupKey)
      if (!price)
        return response.json({ error: 'Billing is not configured yet.' }, 400)

      const checkout = await user.checkout([{ priceId: price.id, quantity: 1 }], {
        mode: 'subscription',
        allowPromotions: true,
        success_url: `${config.app.url}/dashboard?upgraded=1`,
        cancel_url: `${config.app.url}/pricing`,
      })

      return response.json({ url: checkout.url })
    }
    catch {
      // Stripe not configured (no STRIPE_SECRET_KEY) or price not yet created.
      return response.json({ error: 'Billing is not available yet. Please try again soon.' }, 503)
    }
  },
})
