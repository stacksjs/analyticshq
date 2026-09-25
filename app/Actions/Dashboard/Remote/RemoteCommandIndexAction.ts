import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'

/**
 * AnalyticsHQ does not configure dashboard-managed SSH hosts or commands.
 *
 * Keeping this application override prevents the framework default from
 * importing the optional `~/config/remote` module while still giving the
 * dashboard a valid, empty registry.
 */
export default new Action({
  name: 'RemoteCommandIndexAction',
  description: 'List the remote commands configured for AnalyticsHQ',
  method: 'GET',
  async handle() {
    return response.json({
      hosts: [],
      commands: [],
    })
  },
})
