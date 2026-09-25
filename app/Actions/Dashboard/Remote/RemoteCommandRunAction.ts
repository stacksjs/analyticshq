import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'

/**
 * Fail closed because AnalyticsHQ has no remote-command registry or gate.
 */
export default new Action({
  name: 'RemoteCommandRunAction',
  description: 'Reject remote commands because AnalyticsHQ does not configure them',
  method: 'POST',
  async handle() {
    return response.json({
      message: 'Remote commands are not configured for AnalyticsHQ.',
    }, 403)
  },
})
