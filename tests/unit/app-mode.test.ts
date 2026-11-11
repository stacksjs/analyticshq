/**
 * App mode: events from a declared native or desktop app.
 *
 * A desktop app's agent talks HTTP through Bun, Node or a webview. The bot
 * filter drops every one of those, and the visitor id rotates daily, so an app
 * could not record opt-in usage at all: its events answered 204 and vanished,
 * and one install would have been a new visitor every morning anyway.
 *
 * The second half of this file runs the REAL `/collect` handler against rows
 * held in memory (`CollectIo`), because the claims that matter are about what
 * gets stored: no IP, one id per install across days, the app's version and OS
 * in the columns the reports read. A test that reads the source as text cannot
 * say any of that.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APP_VERSION_PATTERN,
  appDimensions,
  coarseOsVersion,
  declaresApp,
  hashInstall,
  INSTALL_ID_PATTERN,
  mintAppSecret,
  normalizeAppOs,
  readAppClient,
  withAppProperties,
} from '../../app/Analytics/app-mode'
import { buildFilterSql, collectFilters, FILTER_COLUMNS, segmentPopulation, shouldSuppress } from '../../app/Analytics/filters'
import { collect, type CollectIo, resetAppSiteCache, resetRegionSiteCache } from '../../routes/analytics'

const ROOT = join(import.meta.dir, '../..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const INSTALL = '3f2b8c1e-9a4d-4e7b-b1c2-0d9e8f7a6b5c'
const OTHER_INSTALL = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SECRET = 'a'.repeat(64)

describe('the app declaration', () => {
  test('is the presence of an app object, and null is not one', () => {
    expect(declaresApp({ s: 'x', app: { id: INSTALL, version: '1.0.0' } })).toBe(true)
    expect(declaresApp({ s: 'x', app: 'yes' })).toBe(true)
    expect(declaresApp({ s: 'x' })).toBe(false)
    expect(declaresApp({ s: 'x', app: null })).toBe(false)
  })

  test('a well-formed one is read, with the id lowercased', () => {
    const parsed = readAppClient({ id: INSTALL.toUpperCase(), version: '1.4.2', os: 'darwin', osVersion: '15.1.1', name: 'Fettler' })
    expect(parsed).toEqual({ client: { installId: INSTALL, name: 'Fettler', version: '1.4.2', os: 'macOS', osVersion: '15.1' } })
  })

  test('an install id that is not a UUID is refused', () => {
    for (const id of ['', 'abc', '12345', `${INSTALL}0`, INSTALL.slice(1), INSTALL.replace(/-/g, ''), 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', 42, null, undefined, 'x'.repeat(5000)]) {
      const parsed = readAppClient({ id, version: '1.0.0' })
      expect({ id, refused: 'error' in parsed }).toEqual({ id, refused: true })
    }
    expect(INSTALL_ID_PATTERN.test(INSTALL)).toBe(true)
    expect(INSTALL).toHaveLength(36)
  })

  test('a missing or malformed version is refused', () => {
    for (const version of [undefined, '', ' ', 'one two', '1'.repeat(33), '<script>', 7]) {
      const parsed = readAppClient({ id: INSTALL, version })
      expect({ version, refused: 'error' in parsed }).toEqual({ version, refused: true })
    }
    for (const version of ['1', '1.4.2', '2.0.0-beta.1', '2026.11+build5'])
      expect({ version, ok: APP_VERSION_PATTERN.test(version) }).toEqual({ version, ok: true })
  })

  test('anything that is not an object is refused', () => {
    for (const raw of ['fettler', 1, true, [], [INSTALL]])
      expect('error' in readAppClient(raw)).toBe(true)
  })

  test('the OS and the name are optional and never a reason to refuse', () => {
    const parsed = readAppClient({ id: INSTALL, version: '1.0.0', os: '<b>', name: { toString: () => 'x' }, osVersion: {} })
    expect(parsed).toEqual({ client: { installId: INSTALL, name: null, version: '1.0.0', os: null, osVersion: null } })
  })
})

describe('the OS an app reports', () => {
  test('is folded to the names the User-Agent parser already writes', () => {
    // One Operating systems report holds web and app traffic. A `darwin` row
    // next to a `macOS` row would split one system in two.
    const cases: Array<[string, string]> = [
      ['darwin', 'macOS'],
      ['macOS', 'macOS'],
      ['MACOS', 'macOS'],
      ['win32', 'Windows'],
      ['Windows', 'Windows'],
      ['linux', 'Linux'],
      ['ios', 'iOS'],
      ['android', 'Android'],
    ]
    for (const [sent, stored] of cases)
      expect({ sent, stored: normalizeAppOs(sent) }).toEqual({ sent, stored })
  })

  test('an unknown system keeps its own short label, and junk is dropped', () => {
    expect(normalizeAppOs('FreeBSD')).toBe('FreeBSD')
    expect(normalizeAppOs('x'.repeat(33))).toBeNull()
    expect(normalizeAppOs('a\nb')).toBeNull()
    expect(normalizeAppOs(12)).toBeNull()
  })

  test('its version is cut to major and minor', () => {
    // A full build number is a far smaller haystack than "macOS 15.1".
    expect(coarseOsVersion('15.1.1')).toBe('15.1')
    expect(coarseOsVersion('24.1.0-arm64')).toBe('24.1')
    expect(coarseOsVersion('10.0.22631')).toBe('10.0')
    expect(coarseOsVersion('11')).toBe('11')
    expect(coarseOsVersion(14)).toBe('14')
    expect(coarseOsVersion('Sequoia')).toBeNull()
    expect(coarseOsVersion(undefined)).toBeNull()
  })

  test('maps onto the columns web traffic fills', () => {
    const { client } = readAppClient({ id: INSTALL, version: '1.4.2', os: 'darwin', osVersion: '15.1.1', name: 'Fettler' }) as { client: Parameters<typeof appDimensions>[0] }
    expect(appDimensions(client)).toEqual({ deviceType: 'desktop', browser: 'Fettler', browserVersion: '1.4.2', os: 'macOS', osVersion: '15.1' })
    expect(appDimensions({ ...client, name: null, os: null, osVersion: null })).toEqual({ deviceType: 'desktop', browser: 'App', browserVersion: '1.4.2', os: 'Unknown', osVersion: null })
    expect(appDimensions({ ...client, os: 'iOS' }).deviceType).toBe('mobile')
  })

  test('is added to an event\'s properties, and the caller cannot overwrite it', () => {
    const { client } = readAppClient({ id: INSTALL, version: '1.4.2', os: 'linux', osVersion: '6.8.0' }) as { client: Parameters<typeof appDimensions>[0] }
    expect(withAppProperties({ plan: 'pro', app_version: '9.9.9', os: 'Solaris', os_version: '1' }, client))
      .toEqual({ plan: 'pro', app_version: '1.4.2', os: 'Linux', os_version: '6.8' })
    expect(withAppProperties(undefined, client)).toEqual({ app_version: '1.4.2', os: 'Linux', os_version: '6.8' })
    expect(withAppProperties('text', { ...client, os: null, osVersion: null })).toEqual({ app_version: '1.4.2' })
    // A caller-sent OS is dropped when the app declared none, never trusted.
    expect(withAppProperties({ os: 'Solaris' }, { ...client, os: null, osVersion: null })).toEqual({ app_version: '1.4.2' })
  })
})

describe('the stored id of an install', () => {
  test('is stable: no date, no IP and no User-Agent goes in', () => {
    expect(hashInstall(INSTALL, 'site', SECRET)).toBe(hashInstall(INSTALL, 'site', SECRET))
    // Three inputs and nothing else. A fourth, defaulted to a date or a salt,
    // would quietly bring the daily reset back.
    expect(hashInstall).toHaveLength(3)
  })

  test('is not the install id, and is as wide as every other visitor id', () => {
    const id = hashInstall(INSTALL, 'site', SECRET)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(id).not.toContain(INSTALL.replace(/-/g, '').slice(0, 12))
  })

  test('cannot be joined across sites, even ones that shared a secret', () => {
    expect(hashInstall(INSTALL, 'site-a', SECRET)).not.toBe(hashInstall(INSTALL, 'site-b', SECRET))
    expect(hashInstall(INSTALL, 'site-a', SECRET)).not.toBe(hashInstall(INSTALL, 'site-a', 'b'.repeat(64)))
  })

  test('separates installs', () => {
    expect(hashInstall(INSTALL, 'site', SECRET)).not.toBe(hashInstall(OTHER_INSTALL, 'site', SECRET))
  })

  test('the secret is 32 random bytes, and fits its column', () => {
    const a = mintAppSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(mintAppSecret()).not.toBe(a)
    expect(read('database/migrations/0000000061-add-app-mode-to-sites.sql')).toContain('"app_secret" varchar(64)')
  })
})

// ---------------------------------------------------------------------------
// The real handler, against rows held in memory
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

interface Store {
  io: CollectIo
  tables: Record<string, Row[]>
  /** Every SQL string the handler ran, in order. */
  queries: string[]
  /** How many times the rotating visitor salt was asked for. */
  saltReads: number
  clock: { now: Date }
}

/** A sites row as the migrations leave it: everything off. */
function site(id: string, over: Row = {}): Row {
  return { id, app_mode: false, app_secret: null, region_geo: false, city_geo: false, visitor_window_days: 1, currency: null, ...over }
}

function store(sites: Row[]): Store {
  const tables: Record<string, Row[]> = { sites: [...sites], sessions: [], page_views: [], custom_events: [], conversions: [], web_vitals: [] }
  const s: Store = { tables, queries: [], saltReads: 0, clock: { now: new Date('2026-11-10T09:00:00Z') }, io: undefined as unknown as CollectIo }

  const recentSession = (table: string, params: unknown[]): Row[] => tables[table]
    .filter(r => r.site_id === params[0] && r.visitor_id === params[1] && String(r.timestamp) >= String(params[2]))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, 1)
    .map(r => ({ session_id: r.session_id }))

  s.io = {
    now: () => s.clock.now,
    // A salt that changes every UTC day, like the real one.
    visitorSalt: async (siteId) => {
      s.saltReads++
      return `salt:${siteId}:${s.clock.now.toISOString().slice(0, 10)}`
    },
    insertOrIgnore: async (table, values) => {
      if (!tables[table].some(r => r.id === values.id))
        tables[table].push({ ...values })
    },
    insert: async (table, values) => {
      tables[table].push({ ...values })
    },
    query: async (sql, params = []) => {
      s.queries.push(sql)
      if (/FROM sites WHERE id/.test(sql))
        return tables.sites.filter(r => r.id === params[0])
      if (/SELECT session_id FROM page_views/.test(sql))
        return recentSession('page_views', params)
      if (/SELECT session_id FROM custom_events/.test(sql))
        return recentSession('custom_events', params)
      if (/FROM goals/.test(sql))
        return []
      if (/INSERT INTO web_vitals/.test(sql)) {
        tables.web_vitals.push({ params })
        return []
      }
      throw new Error(`unexpected query in test: ${sql}`)
    },
  }
  return s
}

const BUN_UA = 'Bun/1.3.2'
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const IP = '203.0.113.77'

function beacon(body: Row, ua: string = BUN_UA, headers: Record<string, string> = {}): { jsonBody: Row, headers: Headers } {
  return { jsonBody: body, headers: new Headers({ 'user-agent': ua, 'x-forwarded-for': IP, 'content-type': 'application/json', ...headers }) }
}

const APP = { id: INSTALL, version: '1.4.2', os: 'darwin', osVersion: '15.1.1', name: 'Fettler' }

async function errorOf(res: Response): Promise<string> {
  const data = await res.json() as { error?: string }
  return String(data.error)
}

beforeEach(() => {
  resetAppSiteCache()
  resetRegionSiteCache()
})

describe('POST /collect in app mode', () => {
  test('an event from a Bun User-Agent is accepted on an app site and stored', async () => {
    const s = store([site('fettler', { app_mode: true, app_secret: SECRET })])
    const res = await collect(beacon({ s: 'fettler', e: 'pageview', u: 'app://fettler/settings', app: APP }), s.io)

    expect(res.status).toBe(204)
    expect(s.tables.page_views).toHaveLength(1)
    expect(s.tables.sessions).toHaveLength(1)
    const view = s.tables.page_views[0]
    expect(view.path).toBe('/settings')
    expect(view.hostname).toBe('fettler')
    expect(view.visitor_id).toBe(hashInstall(INSTALL, 'fettler', SECRET))
    expect(view.session_id).toBe(s.tables.sessions[0].id)
  })

  test('the app version and the OS are recorded where the reports read them', async () => {
    const s = store([site('fettler', { app_mode: true, app_secret: SECRET })])
    await collect(beacon({ s: 'fettler', e: 'pageview', u: 'app://fettler/', app: APP }), s.io)
    await collect(beacon({ s: 'fettler', e: 'Export', u: 'app://fettler/', p: { format: 'csv' }, app: APP }), s.io)

    // The Browsers, Operating systems and Devices reports, and the `browser`
    // and `os` filters, read exactly these columns.
    expect(s.tables.page_views[0]).toMatchObject({ browser: 'Fettler', browser_version: '1.4.2', os: 'macOS', os_version: '15.1', device_type: 'desktop' })
    expect(s.tables.sessions[0]).toMatchObject({ browser: 'Fettler', os: 'macOS', device_type: 'desktop' })
    // Never the HTTP library the agent happened to use.
    expect(JSON.stringify(s.tables)).not.toContain('Bun')

    expect(s.tables.custom_events).toHaveLength(1)
    expect(s.tables.custom_events[0].name).toBe('Export')
    expect(JSON.parse(String(s.tables.custom_events[0].properties))).toEqual({ format: 'csv', app_version: '1.4.2', os: 'macOS', os_version: '15.1' })
  })

  test('one install is one visitor on two different days, from two networks', async () => {
    const s = store([site('fettler', { app_mode: true, app_secret: SECRET })])
    await collect(beacon({ s: 'fettler', e: 'pageview', u: 'app://fettler/', app: APP }), s.io)

    s.clock.now = new Date('2026-11-13T18:30:00Z')
    await collect(beacon({ s: 'fettler', e: 'pageview', u: 'app://fettler/', app: APP }, 'Bun/1.4.0', { 'x-forwarded-for': '198.51.100.9' }), s.io)

    const [monday, thursday] = s.tables.page_views
    expect(String(monday.timestamp).slice(0, 10)).toBe('2026-11-10')
    expect(String(thursday.timestamp).slice(0, 10)).toBe('2026-11-13')
    expect(thursday.visitor_id).toBe(monday.visitor_id)
    // Two days apart is two sessions, of one visitor.
    expect(thursday.session_id).not.toBe(monday.session_id)
    expect(s.tables.sessions).toHaveLength(2)
    // The rotating salt was never involved.
    expect(s.saltReads).toBe(0)
  })

  test('a web visitor on the same site still gets a new id every day', async () => {
    // The contrast that shows the stable id is the app path's doing and that
    // app mode did not lengthen anything for the site's browser traffic.
    const s = store([site('fettler', { app_mode: true, app_secret: SECRET })])
    await collect(beacon({ s: 'fettler', u: 'https://fettler.example/' }, CHROME_UA), s.io)
    s.clock.now = new Date('2026-11-11T09:00:00Z')
    await collect(beacon({ s: 'fettler', u: 'https://fettler.example/' }, CHROME_UA), s.io)

    expect(s.tables.page_views).toHaveLength(2)
    expect(s.tables.page_views[1].visitor_id).not.toBe(s.tables.page_views[0].visitor_id)
    expect(s.tables.page_views[0]).toMatchObject({ browser: 'Chrome', os: 'macOS', browser_version: null, os_version: null })
    expect(s.saltReads).toBe(2)
  })

  test('two installs are two visitors, and one install on two sites cannot be joined', async () => {
    const s = store([site('a', { app_mode: true, app_secret: SECRET }), site('b', { app_mode: true, app_secret: 'b'.repeat(64) })])
    await collect(beacon({ s: 'a', u: 'app://x/', app: APP }), s.io)
    await collect(beacon({ s: 'a', u: 'app://x/', app: { ...APP, id: OTHER_INSTALL } }), s.io)
    await collect(beacon({ s: 'b', u: 'app://x/', app: APP }), s.io)

    const ids = s.tables.page_views.map(r => r.visitor_id)
    expect(new Set(ids).size).toBe(3)
  })

  test('events with no screen view between them share a session', async () => {
    // A tray app can send events for an hour and never show a screen.
    const s = store([site('fettler', { app_mode: true, app_secret: SECRET })])
    await collect(beacon({ s: 'fettler', e: 'Sync', app: APP }), s.io)
    s.clock.now = new Date(s.clock.now.getTime() + 20 * 60 * 1000)
    await collect(beacon({ s: 'fettler', e: 'Sync', app: APP }), s.io)
    s.clock.now = new Date(s.clock.now.getTime() + 20 * 60 * 1000)
    await collect(beacon({ s: 'fettler', e: 'Sync', app: APP }), s.io)

    expect(s.tables.custom_events).toHaveLength(3)
    expect(new Set(s.tables.custom_events.map(r => r.session_id)).size).toBe(1)
    expect(s.tables.sessions).toHaveLength(1)
  })

  test('app mode on a site that has not enabled it is refused out loud', async () => {
    const s = store([site('web-only')])
    const res = await collect(beacon({ s: 'web-only', u: 'app://x/', app: APP }), s.io)

    expect(res.status).toBe(403)
    expect(await errorOf(res)).toContain('App mode is not enabled for this site')
    expect(s.tables.page_views).toHaveLength(0)
    expect(s.tables.sessions).toHaveLength(0)
  })

  test('the same refusal from a browser User-Agent: a field cannot switch a web site over', async () => {
    const s = store([site('web-only')])
    const res = await collect(beacon({ s: 'web-only', u: 'https://web.example/', app: APP }, CHROME_UA), s.io)
    expect(res.status).toBe(403)
    expect(s.tables.page_views).toHaveLength(0)
  })

  test('a site that does not exist is not created by an app beacon', async () => {
    const s = store([])
    const res = await collect(beacon({ s: 'nobody', u: 'app://x/', app: APP }), s.io)
    expect(res.status).toBe(403)
    expect(s.tables.sites).toHaveLength(0)
  })

  test('the flag without a secret, or a query that threw, reads as off', async () => {
    const s = store([site('half', { app_mode: true, app_secret: null })])
    expect((await collect(beacon({ s: 'half', app: APP }), s.io)).status).toBe(403)

    const broken = store([site('fettler', { app_mode: true, app_secret: SECRET })])
    const query = broken.io.query
    broken.io.query = async (sql, params) => {
      if (/app_mode/.test(sql))
        throw new Error('connection reset')
      return query(sql, params)
    }
    expect((await collect(beacon({ s: 'fettler', app: APP }), broken.io)).status).toBe(403)
    expect(broken.tables.page_views).toHaveLength(0)
  })

  test('a plain bun/ User-Agent without the declaration is still dropped, on an app site too', async () => {
    const s = store([site('fettler', { app_mode: true, app_secret: SECRET }), site('web-only')])
    for (const id of ['fettler', 'web-only']) {
      for (const ua of [BUN_UA, 'bun/1.3.2', 'undici', 'node-fetch/3.3.2', 'Mozilla/5.0 Electron/31.0.0']) {
        const res = await collect(beacon({ s: id, u: 'https://x.example/' }, ua), s.io)
        expect({ id, ua, status: res.status }).toEqual({ id, ua, status: 204 })
      }
    }
    expect(s.tables.page_views).toHaveLength(0)
    expect(s.tables.sessions).toHaveLength(0)
    // Dropped before a single query: the bot path costs the database nothing.
    expect(s.queries).toHaveLength(0)
  })

  test('an invalid install id is refused, and nothing is stored', async () => {
    const s = store([site('fettler', { app_mode: true, app_secret: SECRET })])
    for (const id of ['not-a-uuid', '', 12345, 'x'.repeat(4000), `${INSTALL}-extra`]) {
      const res = await collect(beacon({ s: 'fettler', u: 'app://x/', app: { ...APP, id } }), s.io)
      expect({ id: String(id).slice(0, 20), status: res.status }).toEqual({ id: String(id).slice(0, 20), status: 400 })
      expect(await errorOf(res)).toContain('app.id must be a UUID')
    }
    const noVersion = await collect(beacon({ s: 'fettler', app: { id: INSTALL } }), s.io)
    expect(noVersion.status).toBe(400)
    expect(await errorOf(noVersion)).toContain('app.version')
    expect((await collect(beacon({ s: 'fettler', app: 'fettler' }), s.io)).status).toBe(400)

    expect(s.tables.page_views).toHaveLength(0)
    expect(s.tables.sessions).toHaveLength(0)
    expect(s.tables.custom_events).toHaveLength(0)
  })

  test('Web Vitals are refused in app mode', async () => {
    const s = store([site('fettler', { app_mode: true, app_secret: SECRET })])
    const res = await collect(beacon({ s: 'fettler', e: 'vitals', p: { LCP: 1200 }, app: APP }), s.io)
    expect(res.status).toBe(400)
    expect(s.tables.web_vitals).toHaveLength(0)
  })

  test('nothing stored holds the IP, the install id, the secret or the User-Agent', async () => {
    const s = store([site('fettler', { app_mode: true, app_secret: SECRET })])
    await collect(beacon({ s: 'fettler', e: 'pageview', u: 'app://fettler/home', app: APP }), s.io)
    await collect(beacon({ s: 'fettler', e: 'Export', p: { format: 'csv' }, app: APP }), s.io)

    const written = JSON.stringify({ ...s.tables, sites: [] })
    expect(written).not.toContain(IP)
    expect(written).not.toContain('203.0.113')
    expect(written).not.toContain(INSTALL)
    expect(written).not.toContain(SECRET)
    expect(written).not.toContain(BUN_UA)
    // And no column is named for one.
    for (const row of [...s.tables.page_views, ...s.tables.sessions, ...s.tables.custom_events]) {
      for (const column of Object.keys(row))
        expect(column).not.toMatch(/^(?:ip|ip_address|user_agent|ua|install_id)$/)
    }
  })

  test('Global Privacy Control is honoured in app mode as well', async () => {
    const s = store([site('fettler', { app_mode: true, app_secret: SECRET })])
    const res = await collect(beacon({ s: 'fettler', u: 'app://x/', app: APP }, BUN_UA, { 'sec-gpc': '1' }), s.io)
    expect(res.status).toBe(204)
    expect(s.tables.page_views).toHaveLength(0)
  })

  test('turning the setting on is picked up at once, with no cache to wait out', async () => {
    const s = store([site('fettler')])
    expect((await collect(beacon({ s: 'fettler', app: APP }), s.io)).status).toBe(403)
    Object.assign(s.tables.sites[0], { app_mode: true, app_secret: SECRET })
    expect((await collect(beacon({ s: 'fettler', app: APP }), s.io)).status).toBe(204)
  })
})

describe('suppression still applies to app data', () => {
  test('a filter that isolates a few installs is withheld', async () => {
    // Three installs on one release. The filter the dashboard would send to
    // look at them is on `browser` and `os`, the columns app events fill.
    const s = store([site('fettler', { app_mode: true, app_secret: SECRET })])
    const installs = [INSTALL, OTHER_INSTALL, '11111111-2222-4333-8444-555555555555']
    for (const id of installs)
      await collect(beacon({ s: 'fettler', u: 'app://fettler/', app: { ...APP, id } }), s.io)

    const specs = collectFilters({ browser: 'Fettler', os: 'macOS' })
    const filter = buildFilterSql(specs)
    expect(filter.sql).toContain('browser')
    expect(filter.sql).toContain('os')

    // The population is counted over the same table and the same visitor ids
    // an app event writes, so an install counts exactly once.
    let counted = ''
    const population = await segmentPopulation('fettler', '2026-11-01', '2026-12-01', filter, async (sql) => {
      counted = sql
      const rows = s.tables.page_views.filter(r => r.browser === 'Fettler' && r.os === 'macOS')
      return [{ n: new Set(rows.map(r => r.visitor_id)).size }]
    })
    expect(counted).toContain('COUNT(DISTINCT visitor_id) AS n FROM page_views')
    expect(population).toBe(3)
    expect(shouldSuppress(5, specs.length, population)).toBe(true)
    expect(shouldSuppress(5, specs.length, 5)).toBe(false)
  })

  test('no report was given a way around the floor, and no new dimension was added', () => {
    const routes = read('routes/analytics.ts')
    // App data reaches the reports through the existing columns only, so every
    // report that shows it already runs suppressedResponse.
    expect(Object.keys(FILTER_COLUMNS).filter(k => /app|install|version/i.test(k))).toEqual([])
    expect(Object.keys(FILTER_COLUMNS)).toHaveLength(14)
    const top = routes.slice(routes.indexOf('function topDimension'), routes.indexOf(`topDimension('/api/sites/{siteId}/countries'`))
    expect(top).toContain('await suppressedResponse(siteId, from, to, flt)')
    expect(routes).toContain(`topDimension('/api/sites/{siteId}/browsers', 'browser', 'browsers')`)
    expect(routes).toContain(`topDimension('/api/sites/{siteId}/operating-systems', 'os', 'operating_systems')`)
  })
})

describe('the wiring', () => {
  const routes = read('routes/analytics.ts')
  const code = routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const handler = code.slice(code.indexOf('export async function collect('), code.indexOf(`route.post('/collect'`))

  test('the app branch is decided before the bot filter, which is otherwise untouched', () => {
    const declared = handler.indexOf('if (declaresApp(body)) {')
    const bot = handler.indexOf('else if (isBot(ua)) {')
    expect(declared).toBeGreaterThan(0)
    expect(bot).toBeGreaterThan(declared)
    // One call, with the User-Agent and nothing else: no flag was threaded
    // into the filter to weaken it.
    expect([...handler.matchAll(/isBot\(/g)]).toHaveLength(1)
  })

  test('only the owner can turn it on, and the secret goes with the setting', () => {
    const patch = routes.slice(routes.indexOf('if (body.appMode !== undefined) {'))
    const block = patch.slice(0, patch.indexOf('if (!sets.length)'))
    expect(block).toContain('requireSiteOwner(request, siteId)')
    expect(block).toContain(`'app_secret = COALESCE(app_secret, ?)'`)
    expect(block).toContain(`'app_secret = NULL'`)
  })

  test('the secret is never selected into a response', () => {
    // One statement reads it, the ingest's own, and that one returns to no caller.
    const reads = [...code.matchAll(/SELECT[^`]*app_secret/g)]
    expect(reads).toHaveLength(1)
    expect(code).toContain('SELECT app_mode, app_secret FROM sites WHERE id = ? LIMIT 1')
    expect(read('app/Analytics/access.ts')).not.toContain('app_secret')
    expect(read('resources/views/dashboard.stx')).not.toContain('app_secret')
  })

  test('the model declares both columns, so the schema differ keeps them', () => {
    const model = read('app/Models/Site.ts')
    expect(model).toMatch(/app_mode:\s*\{/)
    expect(model).toMatch(/app_secret:\s*\{\s*fillable: false,\s*hidden: true/)
    const sql = read('database/migrations/0000000061-add-app-mode-to-sites.sql')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "app_mode" boolean NOT NULL DEFAULT false')
  })
})
