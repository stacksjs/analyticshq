// The signed-in user, as this app's `users` table has it.
//
// `request.user()` resolves to `AuthenticatedUser`, which the framework types
// with `id` and `email` and leaves the rest to an index signature. It is an
// interface precisely so an application can declare its own columns
// (see @stacksjs/types request.d.ts). Without this, `name` read as `any`
// through that index signature, which is where `(user as any).name` came from.
// Declare every column the app reads here: anything else still resolves
// through the framework's index signature.

import type Stripe from 'stripe'

declare module '@stacksjs/types' {
  interface AuthenticatedUser {
    name: string
    created_at?: string | null
    /** Set by social sign-in, on installs whose users table has the column. */
    avatar?: string | null
    /** Runs the install (app/Analytics/access.ts). Hidden, never fillable. */
    is_platform_admin?: boolean
    /**
     * Start a Stripe Checkout session for this user. app/Models/User.ts sets
     * `traits.billable`, and the ORM binds the billable trait's methods onto
     * every User instance with the model argument already applied, which is
     * what `request.user()` resolves to.
     */
    checkout: (
      prices: Array<{ priceId: string, quantity?: number }>,
      options?: Partial<Stripe.Checkout.SessionCreateParams> & { enableTax?: boolean, allowPromotions?: boolean },
    ) => Promise<Stripe.Checkout.Session>
  }
}

export {}
