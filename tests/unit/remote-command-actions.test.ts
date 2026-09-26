import { describe, expect, it } from 'bun:test'
import RemoteCommandIndexAction, { listRemoteCommands } from '../../app/Actions/Dashboard/Remote/RemoteCommandIndexAction'
import RemoteCommandRunAction, { refuseRemoteCommand } from '../../app/Actions/Dashboard/Remote/RemoteCommandRunAction'

describe('dashboard remote commands', () => {
  it('loads without the optional framework remote config alias', async () => {
    expect(RemoteCommandIndexAction.handle).toBe(listRemoteCommands)
    const result = listRemoteCommands()

    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({
      hosts: [],
      commands: [],
    })
  })

  it('fails closed when a remote command run is requested', async () => {
    expect(RemoteCommandRunAction.handle).toBe(refuseRemoteCommand)
    const result = refuseRemoteCommand()

    expect(result.status).toBe(403)
    expect(await result.json()).toEqual({
      message: 'Remote commands are not configured for AnalyticsHQ.',
    })
  })
})
