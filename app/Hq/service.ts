import type { HqSite, SiteStore } from './adapter'
import process from 'node:process'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { createHqService, sqlConnectCodeStore } from '@stacksjs/hq/service'
import { normalizeOrigin } from '../Analytics/install'
import { mintSiteId } from '../Analytics/sites'
import { mintSiteToken, SITE_SCOPES, siteForToken } from '../Support/site-tokens'
import { num, text } from '../Support/rows'
import { createAnalyticshqAdapter } from './adapter'

/**
 * The HQ service wired to this app's database. routes/hq.ts mounts its three
 * endpoints and the approve page (resources/views/cli/connect.stx) calls
 * `describeConnect`. The table behind the codes is created by 0000000063.
 */

const IS_PG = (process.env.DB_CONNECTION ?? 'postgres') === 'postgres'
type Row = Record<string, unknown>

/** Written with `?` and bound as `$n` on Postgres, as routes/analytics.ts does. */
function query(sql: string, params: unknown[] = []): Promise<Row[]> {
  let i = 0
  return db.unsafe(IS_PG ? sql.replace(/\?/g, () => `$${++i}`) : sql, params)
}

const COLUMNS = 'id, name, owner_id'

function toSite(row: Row | null | undefined): HqSite | null {
  if (!row)
    return null
  return {
    id: String(row.id),
    name: text(row.name) ?? '',
    ownerId: row.owner_id == null ? null : Number(row.owner_id),
  }
}

export const sqlSiteStore: SiteStore = {
  async findOwnedByName(ownerId, name) {
    // lower(), not ILIKE, and oldest first: the same comparison POST
    // /api/sites refuses a duplicate with, so there is at most one in practice.
    return toSite((await query(
      `SELECT ${COLUMNS} FROM sites WHERE owner_id = ? AND lower(name) = lower(?) ORDER BY created_at ASC, id LIMIT 1`,
      [ownerId, name],
    ))?.[0])
  },
  async create(ownerId, name) {
    // Server-minted, never the caller's: the id is public and a guessable one
    // could be registered ahead of its owner (app/Analytics/sites.ts).
    const id = mintSiteId(ownerId, name)
    const now = new Date().toISOString()
    await db.insertInto('sites').values({
      id,
      name,
      domains: '[]',
      timezone: 'UTC',
      is_active: true,
      owner_id: ownerId,
      settings: '{}',
      created_at: now,
      updated_at: now,
    }).execute()
    return { id, name, ownerId }
  },
  async issueReadKey(siteId, name) {
    return (await mintSiteToken(siteId, SITE_SCOPES.read, name)).token
  },
  async findByReadKey(readKey) {
    const target = await siteForToken(readKey, SITE_SCOPES.read)
    // An inactive site's key stops reading, as its dashboard does.
    if (!target || !target.isActive)
      return null
    return toSite((await query(`SELECT ${COLUMNS} FROM sites WHERE id = ? LIMIT 1`, [target.siteId]))?.[0])
  },
}

/** The first instant of the current month, UTC, in the form `page_views.timestamp` is stored in. */
export function monthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/** Page views recorded this month across every site the account owns. */
async function pageviewsUsed(ownerId: number): Promise<number> {
  const row = (await query(
    'SELECT COUNT(*) AS n FROM page_views WHERE timestamp >= ? AND site_id IN (SELECT id FROM sites WHERE owner_id = ?)',
    [monthStart(), ownerId],
  ))?.[0]
  return num(row?.n)
}

/** The public web origin with its scheme, no trailing slash. `config.app.url` is stored without one. */
export function appOrigin(): string {
  return normalizeOrigin(config.app?.url || 'https://analyticshq.org')
}

export const analyticshqAdapter = createAnalyticshqAdapter({
  sites: sqlSiteStore,
  codes: sqlConnectCodeStore(db, { dialect: IS_PG ? 'postgres' : 'sqlite' }),
  origin: appOrigin,
  pageviewsUsed,
})

export const hq = createHqService(analyticshqAdapter)
