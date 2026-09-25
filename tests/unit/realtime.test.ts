/**
 * Live visitors over Server-Sent Events (app/Analytics/realtime.ts).
 *
 * The hub's contract is what makes it scale: work follows the number of
 * WATCHED SITES, never the number of watchers, and nothing runs when nobody
 * is watching. The database half was load-tested against a real Postgres.
 * What is pinned here is the stream lifecycle and the wiring a later edit
 * could quietly turn back into per-viewer work.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveStats, openLiveStream, pokeLive, resetLiveHub } from '../../app/Analytics/realtime'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

afterEach(() => resetLiveHub())

async function firstChunk(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  return new TextDecoder().decode(value)
}

describe('the stream', () => {
  test('is an event stream that proxies will not buffer', () => {
    const res = openLiveStream('site-a')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('cache-control')).toContain('no-transform')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
  })

  test('tells the browser to reconnect after a jittered 2 to 10 seconds', async () => {
    // A restart drops every stream at once. The same delay for all of them
    // would bring every dashboard back in the same instant.
    const delays = new Set<number>()
    for (let i = 0; i < 20; i++) {
      const m = /^retry: (\d+)\n\n$/.exec(await firstChunk(openLiveStream(`site-${i}`)))
      expect(m).not.toBeNull()
      const ms = Number(m![1])
      expect(ms).toBeGreaterThanOrEqual(2000)
      expect(ms).toBeLessThan(10000)
      delays.add(ms)
    }
    expect(delays.size).toBeGreaterThan(1)
  })

  test('many watchers of one site are one watched site', () => {
    for (let i = 0; i < 1000; i++)
      openLiveStream('busy-site')
    openLiveStream('quiet-site')
    expect(liveStats()).toEqual({ sites: 2, streams: 1001 })
  })

  test('closing the last watcher forgets the site', async () => {
    const res = openLiveStream('site-a')
    await res.body!.cancel()
    expect(liveStats()).toEqual({ sites: 0, streams: 0 })
  })

  test('a poke for a site nobody watches does nothing', () => {
    pokeLive('nobody-watching')
    expect(liveStats()).toEqual({ sites: 0, streams: 0 })
  })
})

describe('the wiring', () => {
  const hub = read('app/Analytics/realtime.ts')
  const routes = read('routes/analytics.ts')
  const view = read('resources/views/dashboard.stx')

  test('one grouped query per chunk of sites, not one per viewer', () => {
    // Both live queries group by site over an IN list of every watched site.
    expect(hub).toContain('GROUP BY site_id`')
    expect(hub).toContain('GROUP BY site_id, country, region, city`')
    expect(hub).toContain('await refresh([...watched.keys()])')
    expect(hub).toContain('for (const stream of entry.streams)\n    send(stream, entry.lastBytes, siteId)')
  })

  test('slow readers are dropped rather than buffered', () => {
    expect(hub).toMatch(/desiredSize \?\? 0\) < -MAX_QUEUED/)
  })

  test('the ingest pokes the hub after storing a page view', () => {
    const insert = routes.indexOf(`await db.insertInto('page_views')`)
    const poke = routes.indexOf('pokeLive(String(siteId))')
    expect(insert).toBeGreaterThan(-1)
    expect(poke).toBeGreaterThan(insert)
  })

  test('the dashboard streams, and polls only as a fallback', () => {
    expect(view).toContain('new EventSource(`/api/sites/${encodeURIComponent(activeSiteId)}/live`)')
    expect(view).toContain('poll = useInterval(tick, 10000)')
    // The fallback is reached only from the stream failing or going quiet.
    expect(view.indexOf('startPolling()')).toBeGreaterThan(view.indexOf('new EventSource('))
    expect(view).toContain('Date.now() - heard > 20000')
  })

  test('the map dots follow the stream', () => {
    expect(view).toContain(':data-live-countries="liveMap()"')
    expect(view).toContain(`attributeFilter: ['data-live-countries']`)
  })
})
