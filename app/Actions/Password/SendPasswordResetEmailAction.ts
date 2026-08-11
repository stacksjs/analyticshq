import { Action } from '@stacksjs/actions'
import { RateLimiter } from '@stacksjs/auth'
import { log } from '@stacksjs/logging'
import { User } from '@stacksjs/orm'
import { job } from '@stacksjs/queue'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'

/**
 * Password reset dispatch, overriding the framework default.
 *
 * ## Why this file exists at all
 *
 * `routes/auth.ts` points at `Actions/Password/SendPasswordResetEmailAction`,
 * which the framework supplies. Upstream fixed an account-existence oracle in it
 * (stacksjs/stacks#2214) and the fix is present in the installed
 * `node_modules/@stacksjs/defaults`. We were still running the pre-fix version,
 * because the copy that EXECUTES is the vendored `storage/framework/defaults`
 * tree, and nothing refreshes that:
 *
 *   - `bun install` advances node_modules and leaves the vendored tree alone
 *     (stacksjs/stacks#2303 exists precisely to detect this drift)
 *   - there is no `postinstall` or `prepare` script here
 *   - `config/cloud.ts` `preStart` runs `bun install` and a build, no sync
 *   - `storage/framework/` is gitignored, so a checkout does not carry it
 *
 * The vendored copy was last written 2026-07-23 and had drifted from the
 * published package across 606 files under `app/`. Measured against the running
 * dev API before this override existed:
 *
 *   POST /password/forgot  {"email":"<real account>"}   -> 500 "Failed to send password reset email."
 *   POST /password/forgot  {"email":"<unknown>"}        -> 404 "No account found with this email address."
 *
 * Two different status codes and two different bodies, on an unauthenticated
 * endpoint: anyone could test an arbitrary list of addresses for membership.
 *
 * Overriding here rather than syncing the vendored tree is deliberate. A sync
 * fixes the machine it runs on; it does not survive a fresh checkout, and it is
 * not what deploy does. This file is committed, so the security property holds
 * regardless of what state that gitignored directory happens to be in — which is
 * the correct place for a property we do not want to re-verify every deploy.
 *
 * Delete this file once the app runs a framework release whose vendored defaults
 * carry #2214, and confirm by re-running tests/unit/password-reset-privacy.test.ts
 * against the endpoint rather than by reading a version number.
 *
 * Behaviour is kept deliberately identical to the upstream fix, so the two do not
 * drift into two different ideas of the threat.
 */

/**
 * The one thing this endpoint ever says.
 *
 * Held in a constant because the security property is that EVERY path returns it
 * byte for byte — unknown address, known address, and a mail dispatch that blew
 * up. The moment one branch returns something else, the endpoint is an
 * account-existence oracle again.
 */
export const NEUTRAL_RESPONSE = 'If an account exists for that email address, a password reset link has been sent.'

export default new Action({
  name: 'SendPasswordResetEmailAction',
  description: 'Send Password Reset Email',
  method: 'POST',
  validations: {
    email: {
      rule: schema.string().email().required(),
    },
  },
  async handle(request) {
    const email = request.get('email')

    if (!email)
      return response.error('Email is required', 422)

    // Rate limiting is per-email, so it does not slow enumeration ACROSS
    // addresses at all — the shape of the attack this endpoint invites. It stays
    // because it still limits hammering one mailbox, but it is not the control
    // that protects existence; the uniform response below is.
    const rateLimitKey = `password_reset:${email.toLowerCase()}`
    if (await RateLimiter.isRateLimited(rateLimitKey))
      return response.error('Too many password reset attempts. Please try again later.', 429)

    await RateLimiter.recordFailedAttempt(rateLimitKey)

    const user = await User.where('email', email).first()

    // No early return for a missing user.
    if (user) {
      try {
        await job('SendPasswordResetEmailJob', { email })
          .onQueue('emails')
          .dispatch()
      }
      catch (error) {
        // Swallowed DELIBERATELY, and this is the subtle half. Returning a 500
        // here would reintroduce the oracle whenever the mailer is degraded: an
        // unknown address never reaches dispatch, so it can never 5xx, and
        // "neutral message vs. send failure" becomes the tell. That is exactly
        // the 500-vs-404 split measured above, since mail is not configured in
        // development. The operator gets the failure in the logs; the caller
        // gets what everyone gets.
        log.error('[password-reset] failed to dispatch reset email', error)
      }
    }

    return response.success(NEUTRAL_RESPONSE)
  },
})
