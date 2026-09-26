import type { RequestInstance } from '@stacksjs/types'
import { createHmac } from 'node:crypto'
import { Action } from '@stacksjs/actions'
import { Auth, register } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { response } from '@stacksjs/router'
import { buildAuthCookie } from '../../Support/authCookie'
import { isSocialProvider, socialConfigured, socialDriver, verifyState } from '../../Support/social'

/** The id of the account with this email, or null. */
async function userIdByEmail(email: string): Promise<number | null> {
  const rows = await db.unsafe('SELECT id FROM users WHERE lower(email) = $1 LIMIT 1', [email])
  const id = Number(rows[0]?.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

function fail(message: string): Response {
  // Send the user back to /login with a friendly reason. Errors here are rare
  // (bad state, provider hiccup), so a redirect beats a raw JSON error page.
  const to = `/login?error=${encodeURIComponent(message)}`
  // A plain redirect. This used to call `response.html`, which the response
  // factory does not have, so every failed social sign-in threw inside its own
  // error path and answered 500 instead of landing back on the sign-in page.
  return response.redirect(to, 303)
}

export default new Action({
  name: 'SocialCallbackAction',
  description: 'Handle the OAuth callback from a social provider',
  method: 'GET',
  async handle(request: RequestInstance) {
    const provider = request.getParam('provider')
    const code = String(request.query.code ?? '')
    const state = String(request.query.state ?? '')

    if (!isSocialProvider(provider) || !socialConfigured(provider))
      return fail('Unknown sign-in provider.')
    const driver = socialDriver(provider)
    if (!verifyState(state))
      return fail('Your sign-in link expired. Please try again.')
    if (!code)
      return fail('No authorization code was returned.')

    let social
    try {
      const token = await driver.getAccessToken(code)
      social = await driver.getUserByToken(token)
    }
    catch {
      return fail('We could not complete sign-in with that provider.')
    }

    const email = (social.email || '').toLowerCase().trim()
    if (!email)
      return fail('That account did not share an email address.')

    // Find an existing user by email.
    const existing = await userIdByEmail(email)

    // Never link an unverified provider email onto an existing account
    // (account-takeover vector). A brand new signup is fine.
    if (existing && social.emailVerified === false)
      return fail('That email is not verified with the provider.')

    let userId = existing
    if (!userId) {
      // Create the account through the native register flow (handles hashing
      // and token-client wiring); the password is random and unused for
      // social accounts.
      const randomPassword = createHmac('sha256', String(social.id)).update(`${Date.now()}`).digest('hex')
      await register({ name: social.name || email.split('@')[0], email, password: randomPassword })
      userId = await userIdByEmail(email)
      if (!userId)
        return fail('We could not create your account.')
    }

    // An avatar URL longer than the column is dropped rather than failing the
    // sign-in over a picture. COALESCE keeps the one on file when the provider
    // sends none.
    const avatar = social.avatar && social.avatar.length <= 255 ? social.avatar : null
    await db.unsafe(
      'UPDATE users SET provider = $1, provider_id = $2, avatar = COALESCE($3, avatar) WHERE id = $4',
      [provider, String(social.id), avatar, userId],
    )

    const result = await Auth.loginUsingId(userId)
    if (!result?.token)
      return fail('We could not sign you in.')

    // Uniform HQ auth: mirror the issued bearer into the HttpOnly `auth-token`
    // cookie the SSR dashboard authenticates from (buildAuthCookie), then land
    // on /dashboard as a normal navigation so the server reads the fresh cookie.
    // No localStorage, no bearer in the response, no `?token=` in the URL. The
    // baseline session tier applies - the OAuth path has no "remember me" box.
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/dashboard',
        'Set-Cookie': buildAuthCookie(result.token, result.expiresIn),
      },
    })
  },
})
