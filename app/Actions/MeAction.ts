import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { response } from '@stacksjs/router'
import { isPlatformAdmin } from '../Analytics/access'
import { userIsPro } from '../Analytics/entitlements'
import type { Row } from '../Support/rows'
import { text } from '../Support/rows'

/** A timestamp column as the account page reads it: ISO text, whatever the driver returned. */
function stampOf(v: unknown): string | null {
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? null : v.toISOString()
  return text(v)
}

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
    // The route runs the auth middleware, which stamps the user from either the
    // `auth-token` cookie (dashboard/account credentialed fetch) or a bearer
    // token (external API callers). request.user() returns whichever it resolved.
    const user = await request.user()
    if (!user)
      return response.unauthorized('Authentication required')

    const pro = await userIsPro(user.id)
    // Whether the site list this user gets is the whole install. Display only:
    // every site endpoint resolves it again for itself.
    const platformAdmin = await isPlatformAdmin(user.id)

    // Enrich with profile fields the account page shows. created_at is read on
    // its own: it used to be selected together with `avatar` and `provider`,
    // which no migration had created until 58, so the whole query threw and
    // every account page said "Member since --". They are still read apart, so
    // an install that has not run 58 loses only the avatar.
    const profile = await db.unsafe('SELECT created_at FROM users WHERE id = $1', [user.id])
      .then(rows => rows[0] ?? {}, (): Row => ({}))
    const social = await db.unsafe('SELECT avatar, provider FROM users WHERE id = $1', [user.id])
      .then(rows => rows[0] ?? {}, (): Row => ({}))

    return response.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: text(social.avatar) ?? user.avatar ?? null,
        provider: text(social.provider),
        created_at: stampOf(profile.created_at) ?? user.created_at ?? null,
      },
      pro,
      plan: pro ? 'pro' : 'free',
      platformAdmin,
    })
  },
})
