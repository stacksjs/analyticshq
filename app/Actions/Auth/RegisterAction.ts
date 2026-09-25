import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { Auth, register } from '@stacksjs/auth'
import { dispatch } from '@stacksjs/events'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { buildAuthCookie } from '../../Support/authCookie'

/**
 * Project override of the framework's default RegisterAction (resolved by the
 * `'Actions/Auth/RegisterAction'` string ref in routes/auth.ts; user route
 * files load before the framework defaults, so this file wins).
 *
 * Identical registration flow to the framework default, with one addition: on
 * success the issued bearer is mirrored into the HttpOnly `auth-token` cookie,
 * exactly like LoginAction. Without it a just-registered user has a token but
 * no cookie, so the server-rendered dashboard cannot resolve them during SSR
 * and the post-signup redirect lands on the signed-out gate.
 *
 * analyticshq has NO team model - ownership is `sites.owner_id` + `site_members`,
 * created lazily when the user adds their first site - so there is no personal
 * team to provision here. Registration lands on /dashboard, which shows the
 * "Add a site" empty state.
 */
export default new Action({
  name: 'RegisterAction',
  description: 'Register a new user',
  method: 'POST',

  validations: {
    email: {
      rule: schema.string().email(),
      message: 'Email must be a valid email address.',
    },
    password: {
      rule: schema.string().min(6).max(255),
      message: 'Password must be between 6 and 255 characters.',
    },
    name: {
      rule: schema.string().min(2).max(255),
      message: 'Name must be between 2 and 255 characters.',
    },
  },

  async handle(request: RequestInstance) {
    const email = String(request.get('email') ?? '').toLowerCase().trim()
    const password = request.get('password')
    const name = request.get('name')

    const result = await register({ email, password, name })

    if (result) {
      const user = await Auth.getUserFromToken(result.token)

      // Fire `user:registered` so app/Events.ts listeners (SendWelcomeEmail)
      // run. Fire-and-forget - listener errors are caught by the wildcard
      // handler so a flaky welcome email doesn't fail registration. Skip the
      // dispatch outright when there is no address rather than papering over it.
      if (user?.email) {
        dispatch('user:registered', {
          id: user.id,
          email: user.email,
          name: user.name,
          to: user.email,
        })
      }

      return response.json(
        {
          token: result.token,
          user: {
            id: user?.id,
            email: user?.email,
            name: user?.name,
          },
        },
        { status: 200, headers: { 'Set-Cookie': buildAuthCookie(result.token) } },
      )
    }

    return response.error('Registration failed')
  },
})
