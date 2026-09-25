import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { Auth } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import { clearAuthCookie } from '../../Support/authCookie'

/**
 * Project override of the framework's default LogoutAction - same token
 * revocation, plus clearing the HttpOnly `auth-token` cookie LoginAction sets
 * (see Support/authCookie.ts for why the cookie exists at all).
 */
export default new Action({
  name: 'LogoutAction',
  description: 'Logout from the application',
  method: 'POST',
  async handle(request: RequestInstance) {
    await Auth.logout()

    const clearCookie = clearAuthCookie()

    // The dashboard/account pages log out via a credentialed fetch (XHR), which
    // sends `Accept: application/json` - those get JSON. A plain full-page
    // navigation (Accept: text/html) instead gets a 302 to /login so the raw
    // JSON payload never renders in the browser.
    const accept = String(request.headers?.get?.('accept') ?? '')
    if (accept.includes('text/html')) {
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/login', 'Set-Cookie': clearCookie },
      })
    }

    return response.json(
      { message: 'Successfully logged out' },
      { status: 200, headers: { 'Set-Cookie': clearCookie } },
    )
  },
})
