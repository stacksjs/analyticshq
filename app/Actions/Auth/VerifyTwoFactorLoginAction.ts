import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { Auth, consumeTwoFactorChallenge, verifyTwoFactorLoginCode } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { buildAuthCookie, sessionExpiryMinutes } from '../../Support/authCookie'

/**
 * Second step of a 2FA login: exchange the LoginAction challenge token plus a
 * TOTP code for a real session. Registered at POST /verify-two-factor-login
 * (routes/auth.ts). Mirrors LoginAction's HttpOnly `auth-token` cookie so a
 * 2FA-enabled user's server-rendered dashboard can see their session.
 *
 * Dormant today - no enrollment UI ships, so no account can turn 2FA on - but
 * present and correct so that a 2FA account (enabled by a manual DB flip, or a
 * future enrollment flow) can complete sign-in instead of locking out at the
 * `requires_two_factor` response.
 */
export default new Action({
  name: 'VerifyTwoFactorLoginAction',
  description: 'Exchange a LoginAction 2FA challenge + TOTP code for a real token pack',
  method: 'POST',

  validations: {
    challenge_token: {
      rule: schema.string().min(1),
      message: 'A challenge token is required.',
    },
    code: {
      rule: schema.string().min(6).max(6),
      message: 'Code must be a 6-digit TOTP code.',
    },
  },

  async handle(request: RequestInstance) {
    const challengeToken = request.get('challenge_token')
    const code = request.get('code')

    // Single-use: a second attempt with the same challenge token (right code or
    // wrong) must start over from LoginAction, not retry.
    const userId = await consumeTwoFactorChallenge(challengeToken)
    if (!userId)
      return response.unauthorized('This login attempt has expired - please sign in again.')

    const valid = await verifyTwoFactorLoginCode(userId, code)
    if (!valid)
      return response.unauthorized('Invalid code - please sign in again.')

    // Carry the "remember me" tier the user chose on step 1 through to the
    // session issued here, so a 2FA account is not silently downgraded to the
    // baseline week. The login page re-sends the checkbox with the TOTP code.
    const expiresInMinutes = sessionExpiryMinutes(request.get('remember'))
    const result = await Auth.loginUsingId(userId, { expiresInMinutes })
    if (!result)
      return response.unauthorized('Invalid code - please sign in again.')

    const user = result.user

    return response.json(
      {
        access_token: result.token,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        token: result.token,
        user: {
          id: user?.id,
          email: user?.email,
          name: user?.name,
        },
      },
      { status: 200, headers: { 'Set-Cookie': buildAuthCookie(result.token, result.expiresIn) } },
    )
  },
})
