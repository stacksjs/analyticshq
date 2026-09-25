/**
 * Live visitors, pushed to every open dashboard over Server-Sent Events.
 *
 * ## The shape of the problem
 *
 * The dashboard used to poll /api/sites/{id}/realtime every 15 seconds, and
 * every poll ran two COUNT(DISTINCT) queries over the live window. Database
 * work grew with the number of people LOOKING, not the number of sites: ten
 * thousand open dashboards meant about thirteen hundred queries a second to
 * say mostly "same as before", and each viewer still waited up to 15 seconds.
 *
 * ## What this does instead
 *
 * Each dashboard holds one long-lived `text/event-stream` response. The
 * process keeps one hub: site id -> the streams watching it.
 *
 * - **One ticker per process, not per viewer.** Every TICK_MS it snapshots
 *   every site that has at least one watcher in a single pair of grouped
 *   queries (chunked at SITES_PER_QUERY), whatever the number of watchers.
 *   Database load follows the number of watched sites and nothing else.
 * - **Encode once, write many.** A site's update is serialized once and the
 *   same bytes are enqueued on every stream watching it. A snapshot identical
 *   to the last one is not sent at all.
 * - **Pushed on arrival.** /collect runs in this process, so a page view for a
 *   watched site pokes the hub, which refreshes just that site within
 *   POKE_MS. Pokes coalesce: a site getting a thousand hits a second costs
 *   the same few queries a second as one getting ten.
 * - **Nothing runs when nobody watches.** The ticker and the heartbeat start
 *   with the first stream and stop with the last.
 * - **Slow readers are dropped, not buffered.** A stream whose unsent queue
 *   passes MAX_QUEUED messages is closed. The browser reconnects on its own
 *   (`retry:`) and gets the current state, instead of this process holding an
 *   ever-growing backlog for a tab on a dead connection.
 * - **No reconnect stampede.** Each stream asks the browser to wait a
 *   different 2 to 10 seconds before reconnecting, so a deploy that drops
 *   every stream does not bring them all back in the same instant.
 * - **Capped, with a cheap fallback.** See maxStreams: past the cap a
 *   dashboard polls a snapshot shared by everyone polling that site.
 * - **Kept open through proxies.** A `ping` event every HEARTBEAT_MS keeps
 *   the stream under Bun's idle timeout and the gateway's.
 *
 * Each stream costs a ReadableStream and a Set entry, so a process holds tens
 * of thousands of them comfortably. More than one API process is also fine:
 * each runs its own ticker against the same database, and pokes are only a
 * shortcut on top of it.
 *
 * ## What is sent
 *
 * The same numbers the dashboard renders on load, from the same functions:
 * the live count, the places under the site's disclosure floor
 * (./live.ts), and per-country totals for the map's dots. Country is the
 * coarsest location the product records, and every report already shows it.
 */

import process from 'node:process'
import { db } from '@stacksjs/database'
import privacy from '../../config/privacy'
import type { LiveLocations, LivePlaceRow } from './live'
import { liveLocations } from './live'
import { resolveMinSegmentSize } from './segment-floor'

/** What "online now" means: a page view in the last five minutes. */
export const LIVE_WINDOW_MS = 5 * 60 * 1000
const TICK_MS = 2000
const POKE_MS = 300
const HEARTBEAT_MS = 8000
const MAX_QUEUED = 32
const SITES_PER_QUERY = 500
const FLOOR_TTL_MS = 60_000
/** How long a polled snapshot is shared between pollers of the same site. */
const POLL_TTL_MS = 2000

/**
 * The most streams one process holds open, from ANALYTICSHQ_LIVE_MAX_STREAMS
 * (default 100).
 *
 * Why a cap exists at all: in production a stream does not reach this process
 * directly. It passes through the rpx gateway and the views server's API
 * proxy, and each of those pools its upstream connections (256 by default:
 * RPX_MAX_UPSTREAM_CONNS, and Bun's BUN_CONFIG_MAX_HTTP_REQUESTS for fetch). A
 * stream holds one of those connections for as long as the dashboard is open,
 * so past the pool size every other request to the site, the tracker's
 * /collect included, would queue behind open dashboards. The cap keeps streams
 * well inside the pool. A dashboard over it gets a 503, and the client falls
 * back to polling the shared snapshot, which costs a pooled connection for
 * milliseconds rather than for the whole visit.
 *
 * Raise it together with those pool sizes, never on its own.
 */
export function maxStreams(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ANALYTICSHQ_LIVE_MAX_STREAMS)
  return Number.isInteger(n) && n >= 0 ? n : 100
}

export interface LiveSnapshot {
  current: number
  where: LiveLocations
  /** Live visitors per ISO country, for the map. */
  countries: Array<{ country: string, visitors: number }>
}

interface Stream {
  controller: ReadableStreamDefaultController<Uint8Array>
  closed: boolean
}

interface Watched {
  streams: Set<Stream>
  /** The last snapshot sent, serialized, to skip sending an unchanged one. */
  last: string | null
  /** The same as SSE bytes, for a stream that joins between ticks. */
  lastBytes: Uint8Array | null
}

const encoder = new TextEncoder()
const PING = encoder.encode('event: ping\ndata: \n\n')
/**
 * How long the browser waits before reconnecting a dropped stream: 2 to 10
 * seconds, different for each stream. A deploy restarts the process and drops
 * every stream at once, and each reconnect is an authenticated request. The
 * same fixed delay for all of them would bring every open dashboard back in the
 * same instant.
 */
function retryLine(): Uint8Array {
  return encoder.encode(`retry: ${2000 + Math.floor(Math.random() * 8000)}\n\n`)
}

const watched = new Map<string, Watched>()
const polled = new Map<string, { at: number, snapshot: Promise<LiveSnapshot> }>()
const floors = new Map<string, { floor: number, at: number }>()
const poked = new Set<string>()
let ticker: ReturnType<typeof setInterval> | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let pokeTimer: ReturnType<typeof setTimeout> | null = null
let ticking = false

/** `$1, $2, …` for a list, since an array bind is not portable across drivers. */
function placeholders(n: number, offset = 0): string {
  return Array.from({ length: n }, (_, i) => `$${i + 1 + offset}`).join(', ')
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size)
    out.push(list.slice(i, i + size))
  return out
}

/** Each site's disclosure floor, re-read at most once a minute per site. */
async function floorsFor(siteIds: string[]): Promise<Map<string, number>> {
  const now = Date.now()
  const stale = siteIds.filter(id => (floors.get(id)?.at ?? 0) < now - FLOOR_TTL_MS)
  for (const part of chunks(stale, SITES_PER_QUERY)) {
    const rows = await db.unsafe(`SELECT id, settings FROM sites WHERE id IN (${placeholders(part.length)})`, part)
      .catch(() => []) as Array<{ id: string, settings: string | null }>
    const seen = new Set<string>()
    for (const row of rows ?? []) {
      let settings: unknown = {}
      try {
        settings = JSON.parse(row.settings || '{}')
      }
      catch {}
      floors.set(String(row.id), { floor: resolveMinSegmentSize(settings, privacy.minSegmentSize), at: now })
      seen.add(String(row.id))
    }
    for (const id of part) {
      if (!seen.has(id))
        floors.set(id, { floor: privacy.minSegmentSize, at: now })
    }
  }
  return new Map(siteIds.map(id => [id, floors.get(id)?.floor ?? privacy.minSegmentSize]))
}

/**
 * Live snapshots for many sites in one pair of queries per chunk. Also what
 * the dashboard's first render and the polling fallback read, so a stream
 * update can never disagree with the page it lands on.
 */
export async function liveSnapshots(siteIds: string[], now: Date = new Date()): Promise<Map<string, LiveSnapshot>> {
  const ids = [...new Set(siteIds.map(String))]
  const out = new Map<string, LiveSnapshot>()
  if (!ids.length)
    return out
  const since = new Date(now.getTime() - LIVE_WINDOW_MS).toISOString()
  const floorBySite = await floorsFor(ids)

  for (const part of chunks(ids, SITES_PER_QUERY)) {
    const list = placeholders(part.length, 1)
    const [counts, places] = await Promise.all([
      db.unsafe(
        `SELECT site_id, COUNT(DISTINCT visitor_id) AS current FROM page_views
         WHERE timestamp >= $1 AND site_id IN (${list}) GROUP BY site_id`,
        [since, ...part],
      ),
      db.unsafe(
        `SELECT site_id, country, region, city, COUNT(DISTINCT visitor_id) AS visitors FROM page_views
         WHERE timestamp >= $1 AND site_id IN (${list}) GROUP BY site_id, country, region, city`,
        [since, ...part],
      ),
    ]) as [Array<{ site_id: string, current: number | string }>, Array<LivePlaceRow & { site_id: string }>]

    const currentBySite = new Map((counts ?? []).map(r => [String(r.site_id), Number(r.current)]))
    const placesBySite = new Map<string, LivePlaceRow[]>()
    for (const row of places ?? []) {
      const key = String(row.site_id)
      if (!placesBySite.has(key))
        placesBySite.set(key, [])
      placesBySite.get(key)!.push(row)
    }

    for (const id of part) {
      const current = currentBySite.get(id) ?? 0
      const rows = placesBySite.get(id) ?? []
      const byCountry = new Map<string, number>()
      for (const row of rows) {
        const country = String(row.country ?? '').toUpperCase()
        if (/^[A-Z]{2}$/.test(country))
          byCountry.set(country, (byCountry.get(country) ?? 0) + Number(row.visitors ?? 0))
      }
      out.set(id, {
        current,
        where: current > 0 ? liveLocations(rows, floorBySite.get(id) ?? privacy.minSegmentSize, current) : { locations: [], more: 0, unknown: 0 },
        countries: [...byCountry.entries()]
          .map(([country, visitors]) => ({ country, visitors }))
          .sort((a, b) => b.visitors - a.visitors),
      })
    }
  }
  return out
}

const EMPTY: LiveSnapshot = { current: 0, where: { locations: [], more: 0, unknown: 0 }, countries: [] }

/** One snapshot, for a single site, straight from the database. */
export async function liveSnapshot(siteId: string): Promise<LiveSnapshot> {
  return (await liveSnapshots([siteId])).get(String(siteId)) ?? EMPTY
}

/**
 * A snapshot for the polling fallback, shared between everyone polling the
 * same site. Within POLL_TTL_MS every poll gets the same answer, and polls
 * that arrive while it is being fetched wait on that one fetch instead of
 * starting their own, so ten thousand pollers of one site cost one query pair
 * every two seconds. A site that also has streams is answered from the
 * stream's last snapshot, which the ticker keeps current.
 */
export async function sharedSnapshot(siteId: string): Promise<LiveSnapshot> {
  const id = String(siteId)
  const streamed = watched.get(id)?.last
  if (streamed)
    return JSON.parse(streamed) as LiveSnapshot
  const now = Date.now()
  const hit = polled.get(id)
  if (hit && now - hit.at < POLL_TTL_MS)
    return hit.snapshot
  const snapshot = liveSnapshot(id).catch(() => EMPTY)
  polled.set(id, { at: now, snapshot })
  if (polled.size > 10_000) {
    for (const [key, entry] of polled) {
      if (now - entry.at >= POLL_TTL_MS)
        polled.delete(key)
    }
  }
  return snapshot
}

function send(stream: Stream, bytes: Uint8Array, siteId: string): void {
  if (stream.closed)
    return
  // desiredSize goes negative as unsent messages pile up behind a slow or dead
  // connection. Past MAX_QUEUED, close it rather than hold the backlog.
  if ((stream.controller.desiredSize ?? 0) < -MAX_QUEUED) {
    drop(stream, siteId)
    return
  }
  try {
    stream.controller.enqueue(bytes)
  }
  catch {
    drop(stream, siteId)
  }
}

function drop(stream: Stream, siteId: string): void {
  if (stream.closed)
    return
  stream.closed = true
  try {
    stream.controller.close()
  }
  catch {}
  leave(siteId, stream)
}

function leave(siteId: string, stream: Stream): void {
  stream.closed = true
  const entry = watched.get(siteId)
  if (!entry)
    return
  entry.streams.delete(stream)
  if (!entry.streams.size)
    watched.delete(siteId)
  if (!watched.size)
    stopTimers()
}

/** Serialize a snapshot once and hand the same bytes to every watcher. */
function publish(siteId: string, snapshot: LiveSnapshot): void {
  const entry = watched.get(siteId)
  if (!entry)
    return
  const payload = JSON.stringify(snapshot)
  if (payload === entry.last)
    return
  entry.last = payload
  entry.lastBytes = encoder.encode(`data: ${payload}\n\n`)
  for (const stream of entry.streams)
    send(stream, entry.lastBytes, siteId)
}

async function refresh(siteIds: string[]): Promise<void> {
  if (!siteIds.length)
    return
  try {
    const snaps = await liveSnapshots(siteIds)
    for (const [id, snap] of snaps)
      publish(id, snap)
  }
  catch {
    // A failed tick sends nothing, and the next one tries again. Nothing a
    // watcher sees is ever wrong, only late.
  }
}

async function tick(): Promise<void> {
  if (ticking)
    return
  ticking = true
  try {
    await refresh([...watched.keys()])
  }
  finally {
    ticking = false
  }
}

function startTimers(): void {
  ticker ??= setInterval(() => void tick(), TICK_MS)
  heartbeat ??= setInterval(() => {
    for (const [siteId, entry] of watched) {
      for (const stream of entry.streams)
        send(stream, PING, siteId)
    }
  }, HEARTBEAT_MS)
}

function stopTimers(): void {
  if (ticker)
    clearInterval(ticker)
  if (heartbeat)
    clearInterval(heartbeat)
  ticker = null
  heartbeat = null
}

/**
 * Called by /collect after a page view is stored. A map lookup when nobody is
 * watching the site, which is almost always, so it costs the ingest nothing.
 */
export function pokeLive(siteId: string): void {
  const id = String(siteId)
  if (!watched.has(id))
    return
  poked.add(id)
  pokeTimer ??= setTimeout(() => {
    pokeTimer = null
    const ids = [...poked]
    poked.clear()
    void refresh(ids)
  }, POKE_MS)
}

/** Watchers and watched sites in this process, for /api/health and tests. */
export function liveStats(): { sites: number, streams: number } {
  let streams = 0
  for (const entry of watched.values())
    streams += entry.streams.size
  return { sites: watched.size, streams }
}

/**
 * The event-stream response for one watcher of one site. The caller has
 * already checked they may read it. The current state is sent at once: the
 * last snapshot if one is fresh, otherwise a poke fetches it.
 */
export function openLiveStream(siteId: string): Response {
  const id = String(siteId)
  if (liveStats().streams >= maxStreams()) {
    // Over the cap: refuse fast, and the client polls sharedSnapshot instead.
    return new Response('Too many live streams on this server. Polling instead.', {
      status: 503,
      headers: { 'Retry-After': '60', 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  let stream: Stream | null = null
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = { controller, closed: false }
      let entry = watched.get(id)
      if (!entry) {
        entry = { streams: new Set(), last: null, lastBytes: null }
        watched.set(id, entry)
      }
      entry.streams.add(stream)
      startTimers()
      controller.enqueue(retryLine())
      if (entry.lastBytes)
        controller.enqueue(entry.lastBytes)
      else pokeLive(id)
    },
    cancel() {
      if (stream)
        leave(id, stream)
    },
  })
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Tells nginx-style proxies not to buffer the stream.
      'X-Accel-Buffering': 'no',
    },
  })
}

/** Test seam: forget every watcher and stop the timers. */
export function resetLiveHub(): void {
  for (const [siteId, entry] of watched) {
    for (const stream of [...entry.streams])
      drop(stream, siteId)
  }
  watched.clear()
  floors.clear()
  polled.clear()
  poked.clear()
  if (pokeTimer)
    clearTimeout(pokeTimer)
  pokeTimer = null
  stopTimers()
}
