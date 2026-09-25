import { describe, expect, it } from 'bun:test'
import RemoteCommandIndexAction from '../../app/Actions/Dashboard/Remote/RemoteCommandIndexAction'
import RemoteCommandRunAction from '../../app/Actions/Dashboard/Remote/RemoteCommandRunAction'

describe('dashboard remote commands', () => {
  it('loads without the optional framework remote config alias', async () => {
    const result = await RemoteCommandIndexAction.handle()

    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({
      hosts: [],
      commands: [],
    })
  })

  it('fails closed when a remote command run is requested', async () => {
    const result = await RemoteCommandRunAction.handle()

    expect(result.status).toBe(403)
    expect(await result.json()).toEqual({
      message: 'Remote commands are not configured for AnalyticsHQ.',
    })
  })
})
