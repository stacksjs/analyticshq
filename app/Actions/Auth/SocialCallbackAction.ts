import type { RequestInstance } from '@stacksjs/types'
import { createHmac } from 'node:crypto'
import { Action } from '@stacksjs/actions'
import { Auth, register } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { response } from '@stacksjs/router'
import { GitHubProvider, GoogleProvider } from '@stacksjs/socials'

function makeDriver(provider: string): GitHubProvider | GoogleProvider | null {
  const svc = config.services as any
  if (provider === 'github')
    return new GitHubProvider({ clientId: svc.github?.clientId ?? '', clientSecret: svc.github?.clientSecret ?? '', redirectUrl: svc.github?.redirectUrl ?? '' })
  if (provider === 'google')
    return new GoogleProvider({ clientId: svc.google?.clientId ?? '', clientSecret: svc.google?.clientSecret ?? '', redirectUrl: svc.google?.redirectUrl ?? '' })
  return null
}

function verifyState(state: string): boolean {
  const [ts, sig] = String(state || '').split('.')
  if (!ts || !sig)
    return false
  const secret = String((config.app as any)?.key || process.env.APP_KEY || 'stacks-oauth')
  const expect = createHmac('sha256', secret).update(ts).digest('hex').slice(0, 32)
  if (sig !== expect)
    return false
  return Date.now() - Number(ts) < 600_000
}

function fail(message: string): Response {
  // Send the user back to /login with a friendly reason. Errors here are rare
  // (bad state, provider hiccup), so a redirect beats a raw JSON error page.
  const to = `/login?error=${encodeURIComponent(message)}`
  return response.html(`<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><script>location.replace(${JSON.stringify(to)})</script>Redirecting...`, 400)
}

export default new Action({
  name: 'SocialCallbackAction',
  description: 'Handle the OAuth callback from a social provider',
  method: 'GET',
  async handle(request: RequestInstance) {
    const provider = String((request as any).getParam?.('provider') ?? (request as any).params?.provider ?? '')
    const query = (request as any).query ?? {}
    const code = String(query.code ?? '')
    const state = String(query.state ?? '')

    const driver = makeDriver(provider)
    if (!driver)
      return fail('Unknown sign-in provider.')
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
    const existing = await db.selectFrom('users').where('email', '=', email).selectAll().executeTakeFirst() as any

    // Never link an unverified provider email onto an existing account
    // (account-takeover vector). A brand new signup is fine.
    if (existing && social.emailVerified === false)
      return fail('That email is not verified with the provider.')

    let userId: number
    if (existing) {
      userId = Number(existing.id)
      await db.updateTable('users')
        .set({ provider, provider_id: String(social.id), avatar: social.avatar ?? existing.avatar ?? null })
        .where('id', '=', userId)
        .execute()
    }
    else {
      // Create the account through the native register flow (handles hashing
      // and token-client wiring); the password is random and unused for
      // social accounts.
      const randomPassword = createHmac('sha256', String(social.id)).update(`${Date.now()}`).digest('hex')
      await register({ name: social.name || email.split('@')[0], email, password: randomPassword } as any)
      const created = await db.selectFrom('users').where('email', '=', email).selectAll().executeTakeFirst() as any
      if (!created)
        return fail('We could not create your account.')
      userId = Number(created.id)
      await db.updateTable('users')
        .set({ provider, provider_id: String(social.id), avatar: social.avatar ?? null })
        .where('id', '=', userId)
        .execute()
    }

    const result = await Auth.loginUsingId(userId)
    if (!result?.token)
      return fail('We could not sign you in.')

    // Hand the token pack to the client (token auth uses localStorage). Values are
    // embedded in the response body, never in the URL.
    //
    // DOUBLE stringify, and it is not a typo. The session store persists through
    // useLocalStorage, which JSON.stringifies on write -- so the string that belongs
    // IN localStorage under 'token' is `"abc"`, quotes included. The inner call builds
    // that stored form; the outer one turns it into a JS string literal for this
    // script. The previous single call emitted `setItem('token', "abc")`, which stored
    // a bare `abc` that only survived because the store carries a migration shim for
    // exactly this. For 'user' it was worse: `setItem('user', {"id":1,...})` passed an
    // OBJECT to setItem, which coerces to the literal string "[object Object]" — so
    // every social sign-in stored a broken user and session.user() was that string
    // rather than a user. Fixed here rather than papered over downstream.
    //
    // escapeForScript closes the other hole: a display name containing `</script>`
    // would otherwise terminate this block early.
    const escapeForScript = (value: unknown): string =>
      JSON.stringify(JSON.stringify(value)).replace(/</g, '\\u003c')

    const tokenLiteral = escapeForScript(result.token)
    // #32: without this the social path signs you in for exactly one hour.
    const refreshLiteral = escapeForScript(result.refreshToken ?? '')
    const userLiteral = escapeForScript({ id: userId, email, name: social.name })

    return response.html(
      `<!doctype html><meta charset="utf-8"><title>Signing you in</title>`
      + `<script>try{`
      + `localStorage.setItem('token', ${tokenLiteral});`
      + `localStorage.setItem('refresh_token', ${refreshLiteral});`
      + `localStorage.setItem('user', ${userLiteral})`
      + `}catch(e){}`
      + `location.replace('/account')</script>Signing you in...`,
      200,
    )
  },
})
