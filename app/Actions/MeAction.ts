import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { response } from '@stacksjs/router'
import { userIsPro } from '../Analytics/entitlements'

/**
 * Return the authenticated user plus their Pro status. The dashboard calls this
 * to gate Pro features and reflect the plan after a successful checkout. Pro is
 * true when a local `subscriptions` row for this user (type 'default') is
 * active/trialing — kept in sync by the Stripe webhook.
 *
 * Resolved by `userIsPro()` rather than `Payment.hasActiveSubscription()` so
 * this endpoint and the server-side plan gates share one definition. They must
 * not drift: this is what paints the header badge, and a badge that says Pro
 * while the gate says otherwise is a support ticket. The framework helper also
 * reads an unordered first row, which returns the wrong one once a customer has
 * both a canceled and a current subscription — see entitlements.ts.
 */
export default new Action({
  name: 'MeAction',
  description: 'Return the current user and their Pro status',
  method: 'GET',
  async handle(request: RequestInstance) {
    const authHeader = ((request as any).headers?.get?.('authorization') ?? '')
    const bearer = (request as any).bearerToken?.() ?? authHeader.replace(/^Bearer\s+/i, '')
    const user = bearer ? await Auth.getUserFromToken(bearer) : await request.user()
    if (!user)
      return response.unauthorized('Authentication required')

    const pro = await userIsPro((user as any).id)

    // Enrich with profile fields the account page shows (avatar + which
    // provider the account signed in with). Tolerate columns not existing yet.
    let profile: any = {}
    try {
      profile = await db.selectFrom('users')
        .where('id', '=', (user as any).id)
        .select(['avatar', 'provider', 'created_at'])
        .executeTakeFirst() ?? {}
    }
    catch {
      profile = {}
    }

    return response.json({
      user: {
        id: (user as any).id,
        name: (user as any).name,
        email: (user as any).email,
        avatar: profile.avatar ?? (user as any).avatar ?? null,
        provider: profile.provider ?? null,
        created_at: profile.created_at ?? null,
      },
      pro,
      plan: pro ? 'pro' : 'free',
    })
  },
})
