import type { ConnectGrant } from '@stacksjs/hq/service'
import type { HqSite, HqUser, SiteStore } from '../../app/Hq/adapter'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { confirmationCode, connectCodesMigrationSql, createHqService, createMemoryConnectCodeStore } from '@stacksjs/hq/service'
import { hqServiceContract } from '@stacksjs/hq/testing'
import { createAnalyticshqAdapter, PAGEVIEWS_METER } from '../../app/Hq/adapter'
import { rateLimit } from '../../app/Hq/limits'
import { sameOrigin } from '../../app/Support/origin'
import { looksLikeReadKey, newReadKey } from '../../app/Support/read-key'

const ROOT = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const ORIGIN = 'https://analyticshq.test'

/** The `sites` table, as much of it as the adapter touches. */
function memorySites(seed: HqSite[] = []): SiteStore & { rows: HqSite[], touched: string[] } {
  const rows = seed.map(site => ({ ...site }))
  const touched: string[] = []
  return {
    rows,
    touched,
    async findOwnedByName(ownerId, name) {
      const found = rows.find(site => site.ownerId === ownerId && site.name.toLowerCase() === name.toLowerCase())
      return found ? { ...found } : null
    },
    async create(ownerId, name) {
      const site: HqSite = { id: `site${rows.length + 1}${'0'.repeat(18)}`.slice(0, 24), name, ownerId, readKey: null }
      rows.push(site)
      return { ...site }
    },
    async setReadKey(siteId, readKey) {
      rows.find(site => site.id === siteId)!.readKey = readKey
    },
    async findByReadKey(readKey) {
      const found = rows.find(site => site.readKey === readKey)
      return found ? { ...found } : null
    },
    async touchReadKey(siteId) {
      touched.push(siteId)
    },
  }
}

function setup(options: { sites?: HqSite[], used?: Record<number, number> } = {}) {
  const sites = memorySites(options.sites)
  const used = options.used ?? {}
  const adapter = createAnalyticshqAdapter({
    sites,
    codes: createMemoryConnectCodeStore(),
    origin: () => ORIGIN,
    pageviewsUsed: async ownerId => used[ownerId] ?? 0,
  })
  const clock = { at: Date.parse('2026-03-10T12:00:00.000Z') }
  const service = createHqService(adapter, { now: () => new Date(clock.at) })

  const call = async (path: string, init: { method?: string, body?: unknown, headers?: Record<string, string> } = {}) => {
    const response = await service.handle(new Request(`${ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }))
    return { status: response!.status, body: await response!.json() as unknown }
  }
  const start = async (app: string) => (await call('/api/cli/connect', { method: 'POST', body: { app } })).body as { code: string, approveUrl: string }
  const connect = async (app: string, user: HqUser): Promise<ConnectGrant> => {
    const { code } = await start(app)
    await service.approveConnect(code, user)
    return (await call(`/api/cli/connect/${code}`)).body as ConnectGrant
  }
  const usage = (key?: string) => call('/api/v1/usage', { headers: key ? { Authorization: `Bearer ${key}` } : undefined })

  return { sites, adapter, service, clock, call, start, connect, usage }
}

const ALICE: HqUser = { id: 1 }
const BOB: HqUser = { id: 2 }

// The package's own suite, against this app's adapter rather than the
// in-memory reference one: codes hashed at rest, single use under concurrent
// polls, expiry, project reuse, read-key refusal and the usage shape.
hqServiceContract('analyticshq', () => ({ adapter: setup().adapter, user: ALICE }))

describe('connect flow', () => {
  test('a new code is pending and points at this service\'s approve page', async () => {
    const { start, call, service } = setup()
    const { code, approveUrl } = await start('cursio')
    expect(approveUrl).toBe(`${ORIGIN}/cli/connect?code=${code}`)
    expect(await call(`/api/cli/connect/${code}`)).toEqual({ status: 200, body: { status: 'pending' } })
    expect(await service.describeConnect(code)).toMatchObject({ app: 'cursio' })
  })

  test('approving creates a site named after the app and hands over its id and read key once', async () => {
    const { start, call, service, sites } = setup()
    const { code } = await start('cursio')
    expect(await service.approveConnect(code, ALICE)).toEqual({ ok: true, project: { id: sites.rows[0]!.id, name: 'cursio' } })

    const first = await call(`/api/cli/connect/${code}`)
    expect(first.status).toBe(200)
    expect(first.body).toEqual({
      status: 'approved',
      project: { id: sites.rows[0]!.id, name: 'cursio' },
      // The tracker writes with the public site id: there is no ingest secret.
      ingestKey: sites.rows[0]!.id,
      readKey: sites.rows[0]!.readKey,
      dashboardUrl: `${ORIGIN}/dashboard?site=${sites.rows[0]!.id}`,
    })
    expect(looksLikeReadKey((first.body as ConnectGrant).readKey)).toBe(true)
    expect(sites.rows[0]).toMatchObject({ ownerId: 1 })

    expect(await call(`/api/cli/connect/${code}`)).toEqual({ status: 404, body: { status: 'expired' } })
  })

  test('a code that is never approved expires, and no site is made for it', async () => {
    const { start, call, service, clock, sites } = setup()
    const { code } = await start('cursio')
    clock.at += 10 * 60_000 + 1
    expect(await call(`/api/cli/connect/${code}`)).toEqual({ status: 404, body: { status: 'expired' } })
    expect(await service.approveConnect(code, ALICE)).toEqual({ ok: false, reason: 'expired' })
    expect(await service.describeConnect(code)).toBeNull()
    expect(sites.rows).toEqual([])
  })

  test('connecting an app that already exists reuses the site and keeps its read key', async () => {
    const { connect, sites } = setup()
    const first = await connect('Cursio', ALICE)
    // A second machine, and a different capitalisation of the same name.
    const second = await connect('cursio', ALICE)
    expect(sites.rows).toHaveLength(1)
    expect(second.project).toEqual(first.project)
    // Not rotated: the first machine's deployment is still reading with it.
    expect(second.readKey).toBe(first.readKey)
  })

  test('a site made in the dashboard, with no read key yet, is issued one', async () => {
    const existing: HqSite = { id: 'a'.repeat(24), name: 'cursio', ownerId: 1, readKey: null }
    const { connect, sites } = setup({ sites: [existing] })
    const grant = await connect('cursio', ALICE)
    expect(grant.project.id).toBe('a'.repeat(24))
    expect(looksLikeReadKey(grant.readKey)).toBe(true)
    expect(sites.rows[0]!.readKey).toBe(grant.readKey)
  })

  test('two accounts connecting the same app name get separate sites', async () => {
    const { connect, sites } = setup()
    const mine = await connect('api', ALICE)
    const theirs = await connect('api', BOB)
    expect(sites.rows).toHaveLength(2)
    expect(theirs.project.id).not.toBe(mine.project.id)
    expect(theirs.readKey).not.toBe(mine.readKey)
  })

  test('only a signed-in user with a numeric id can approve', async () => {
    const { start, service, sites } = setup()
    const { code } = await start('cursio')
    await expect(service.approveConnect(code, { id: 'not-a-user' })).rejects.toBeInstanceOf(TypeError)
    expect(sites.rows).toEqual([])
  })
})

describe('GET /api/v1/usage', () => {
  test('reports this month\'s page views for the account, against no limit', async () => {
    const { connect, usage, sites } = setup({ used: { 1: 4120 } })
    const grant = await connect('cursio', ALICE)
    const { status, body } = await usage(grant.readKey)
    expect(status).toBe(200)
    expect(body).toEqual([{ meter: PAGEVIEWS_METER, used: 4120, limit: null, period: '2026-03', state: 'ok', upgradeUrl: `${ORIGIN}/pricing` }])
    expect(sites.touched).toEqual([grant.project.id])
  })

  test('the public site id is not a read key, and neither is an unknown key', async () => {
    const { connect, usage } = setup()
    const grant = await connect('cursio', ALICE)
    expect((await usage(grant.ingestKey)).status).toBe(401)
    expect((await usage(newReadKey())).status).toBe(401)
    expect((await usage()).status).toBe(401)
  })

  test('a revoked key stops reading at once', async () => {
    const { connect, usage, sites } = setup()
    const grant = await connect('cursio', ALICE)
    sites.rows[0]!.readKey = null
    expect((await usage(grant.readKey)).status).toBe(401)
  })
})

describe('the approve step', () => {
  test('the confirmation code is what the package derives from the connect code', async () => {
    const { start } = setup()
    const { code } = await start('cursio')
    expect(await confirmationCode(code)).toMatch(/^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/)
  })

  test('the route answers the code to the CLI and refuses an approval without it', () => {
    const routes = read('routes/hq.ts')
    expect(routes).toContain('confirmCode: body.confirmCode ?? await confirmationCode(body.code)')
    expect(routes).toContain('confirmationMatches(code, request.jsonBody?.confirm)')
    // The check sits before the approval, and the route needs a session.
    expect(routes.indexOf('confirmationMatches(code')).toBeLessThan(routes.indexOf('hq.approveConnect(code'))
    expect(routes).toMatch(/\/api\/cli\/connect\/\{code\}\/approve[\s\S]*\.middleware\('auth'\)/)
  })

  test('the page asks for the code and never renders it', () => {
    const page = read('resources/views/cli/connect.stx')
    expect(page).toContain('name="confirm"')
    expect(page).toContain('JSON.stringify({ confirm: typed })')
    expect(page).not.toContain('confirmationCode')
    expect(page).not.toContain('confirmCode')
    // No em-dash or separator en-dash in what a person reads.
    expect(page).not.toMatch(/[–—]/)
  })

  test('guesses are limited per person, and the window reopens', () => {
    const key = `test:${Math.random()}`
    for (let i = 0; i < 10; i++)
      expect(rateLimit(key, 10, 60_000, 1000).ok).toBe(true)
    expect(rateLimit(key, 10, 60_000, 2000)).toEqual({ ok: false, retryAfter: 59 })
    expect(rateLimit(key, 10, 60_000, 61_000).ok).toBe(true)
  })

  test('a cross-site Origin is refused, ours and none are not', () => {
    const request = (origin?: string) => ({ headers: new Headers(origin ? { origin } : {}) })
    expect(sameOrigin(request(), 'analyticshq.org')).toBe(true)
    expect(sameOrigin(request('https://analyticshq.org'), 'analyticshq.org')).toBe(true)
    expect(sameOrigin(request('https://www.analyticshq.org'), 'https://analyticshq.org')).toBe(true)
    expect(sameOrigin(request('https://evil.example'), 'analyticshq.org')).toBe(false)
    expect(sameOrigin(request('not a url'), 'analyticshq.org')).toBe(false)
    expect(sameOrigin(request('https://analyticshq.org'), '')).toBe(false)
  })
})

describe('the connect codes table', () => {
  test('the committed migration is the package\'s schema', () => {
    const normalize = (sql: string): string => sql.replace(/\s+/g, '').replace(/;$/, '').toLowerCase()
    const committed = read('database/migrations/0000000063-create-hq_connect_codes-table.sql')
      .split('\n').filter(line => !line.startsWith('--')).join('\n')
    expect(normalize(committed)).toBe(normalize(connectCodesMigrationSql()[0]!))
  })

  test('its comments hold no semicolon, which the migration runner would split on', () => {
    const comments = read('database/migrations/0000000063-create-hq_connect_codes-table.sql')
      .split('\n').filter(line => line.startsWith('--')).join('\n')
    expect(comments).not.toContain(';')
  })
})
