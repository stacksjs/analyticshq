/**
 * Live visitors over Server-Sent Events (app/Analytics/realtime.ts).
 *
 * The hub's contract is what makes it scale: work follows the number of
 * WATCHED SITES, never the number of watchers, and nothing runs when nobody
 * is watching. The database half was load-tested against a real Postgres.
 * What is pinned here is the stream lifecycle and the wiring a later edit
 * could quietly turn back into per-viewer work.
 */
import process from 'node:process'
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveStats, maxStreams, openLiveStream, pokeLive, resetLiveHub } from '../../app/Analytics/realtime'

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
    process.env.ANALYTICSHQ_LIVE_MAX_STREAMS = '5000'
    try {
      for (let i = 0; i < 1000; i++)
        openLiveStream('busy-site')
      openLiveStream('quiet-site')
      expect(liveStats()).toEqual({ sites: 2, streams: 1001 })
    }
    finally {
      delete process.env.ANALYTICSHQ_LIVE_MAX_STREAMS
    }
  })

  test('past the cap a stream is refused fast, so the client polls instead', () => {
    // Each stream holds a pooled proxy connection in production. Unbounded, open
    // dashboards would starve every other request to the site of connections.
    process.env.ANALYTICSHQ_LIVE_MAX_STREAMS = '3'
    try {
      const codes = Array.from({ length: 5 }, () => openLiveStream('capped').status)
      expect(codes).toEqual([200, 200, 200, 503, 503])
      expect(liveStats().streams).toBe(3)
    }
    finally {
      delete process.env.ANALYTICSHQ_LIVE_MAX_STREAMS
    }
  })

  test('the cap defaults well inside a 256-connection proxy pool', () => {
    expect(maxStreams({})).toBe(100)
    expect(maxStreams({ ANALYTICSHQ_LIVE_MAX_STREAMS: 'lots' })).toBe(100)
    expect(maxStreams({ ANALYTICSHQ_LIVE_MAX_STREAMS: '20000' })).toBe(20000)
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

  test('polls share one snapshot per site', () => {
    expect(routes).toContain('return json(await sharedSnapshot(String(siteId)))')
    expect(hub).toContain('if (hit && now - hit.at < POLL_TTL_MS)')
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
    expect(view).toContain('poll = useInterval(tick, 5000)')
    // The fallback is reached only from the stream failing or going quiet.
    expect(view.indexOf('startPolling()')).toBeGreaterThan(view.indexOf('new EventSource('))
    expect(view).toContain('Date.now() - heard > 20000')
  })

  test('the map dots follow the stream', () => {
    expect(view).toContain(':data-live-points="liveMap()"')
    expect(view).toContain(`attributeFilter: ['data-live-points']`)
  })
})

describe('map points', () => {
  const { livePoints } = require('../../app/Analytics/live') as typeof import('../../app/Analytics/live')
  const table: Record<string, [number, number]> = { 'US-CA:Santa Monica': [34, -118.5], 'US-CA': [36.4, -120] }
  const locate = (k: { city?: string | null, region?: string | null }) => (k.city ? table[k.city] : k.region ? table[k.region] : null) ?? null
  const rows = [
    { country: 'US', region: 'US-CA', city: 'US-CA:Santa Monica', visitors: 1 },
    { country: 'US', region: 'US-TX', city: 'US-TX:Austin', visitors: 1 },
    { country: 'DE', region: null, city: null, visitors: 2 },
  ]

  test('with the floor off, a visitor lands on their city', () => {
    const points = livePoints(rows, 0, locate)
    expect(points.find(p => p.key === 'city:US-CA:Santa Monica')?.at).toEqual([34, -118.5])
    // A city the gazetteer lacks falls to its region, then its country.
    expect(points.find(p => p.key === 'country:US')?.at).toBeNull()
    expect(points.find(p => p.key === 'country:DE')).toMatchObject({ visitors: 2, at: null })
  })

  test('under the floor, a lone visitor is never placed on their town', () => {
    const points = livePoints(rows, 5, locate)
    expect(points.some(p => p.key.startsWith('city:') || p.key.startsWith('region:'))).toBe(false)
    expect(points.find(p => p.key === 'country:US')).toMatchObject({ visitors: 2, at: null })
  })

  test('the ingest never touches the gazetteer', () => {
    // Coordinates exist only for drawing places. geo.ts and the /collect path
    // must never import them.
    expect(read('app/Analytics/geo.ts')).not.toMatch(/from '[^']*city-points'/)
    expect(read('routes/analytics.ts')).not.toMatch(/from '[^']*city-points'/)
    expect(read('app/Analytics/realtime.ts')).toContain(`import { pointOf } from './city-points'`)
  })

  test('the gazetteer is rounded to about 11km', () => {
    expect(read('scripts/geo/build-city-points.ts')).toContain('const round = (x: number) => Math.round(x * 10) / 10')
  })
})
