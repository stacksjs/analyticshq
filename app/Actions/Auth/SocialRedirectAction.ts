import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { isSocialProvider, signState, socialConfigured, socialDriver } from '../../Support/social'

/**
 * Begin an OAuth sign-in with a social provider (GitHub or Google) using the
 * native @stacksjs/socials drivers. The provider credentials come from
 * config.services.{github,google} (env-driven). We hand the driver a signed,
 * time-bounded `state` value so the callback can reject forged requests
 * without needing server-side session storage (this app uses token auth).
 */
export default new Action({
  name: 'SocialRedirectAction',
  description: 'Redirect to a social provider for OAuth sign-in',
  method: 'GET',
  async handle(request: RequestInstance) {
    const provider = request.getParam('provider')
    if (!isSocialProvider(provider))
      return response.json({ error: 'Unknown provider' }, 404)
    const state = signState()
    if (!socialConfigured(provider) || !state)
      return response.json({ error: `${provider} sign-in is not configured yet.` }, 503)

    const url = await socialDriver(provider).withState(state).getAuthUrl()
    return new Response(null, { status: 302, headers: { Location: url } })
  },
})
