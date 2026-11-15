import type { HqSite, SiteStore } from './adapter'
import process from 'node:process'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { createHqService, sqlConnectCodeStore } from '@stacksjs/hq/service'
import { normalizeOrigin } from '../Analytics/install'
import { mintSiteId } from '../Analytics/sites'
import { shouldRecordUse } from '../Support/read-key'
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

const COLUMNS = 'id, name, owner_id, read_key, read_key_last_used_at'

function toSite(row: Row | null | undefined): (HqSite & { readKeyLastUsedAt: string | null }) | null {
  if (!row)
    return null
  return {
    id: String(row.id),
    name: text(row.name) ?? '',
    ownerId: row.owner_id == null ? null : Number(row.owner_id),
    readKey: text(row.read_key),
    readKeyLastUsedAt: text(row.read_key_last_used_at),
  }
}

/** When each key was last stamped, so the stamp costs a write a minute, not one per read. */
const lastStamped = new Map<string, Date>()

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
    return { id, name, ownerId, readKey: null }
  },
  async setReadKey(siteId, readKey) {
    // A new key starts with no last-used stamp, as POST /api/sites/{id}/read-key writes it.
    await query('UPDATE sites SET read_key = ?, read_key_last_used_at = NULL WHERE id = ?', [readKey, siteId])
  },
  async findByReadKey(readKey) {
    const site = toSite((await query(`SELECT ${COLUMNS} FROM sites WHERE read_key = ? LIMIT 1`, [readKey]))?.[0])
    if (site && !lastStamped.has(site.id) && site.readKeyLastUsedAt)
      lastStamped.set(site.id, new Date(site.readKeyLastUsedAt))
    return site
  },
  async touchReadKey(siteId) {
    const now = new Date()
    if (!shouldRecordUse(lastStamped.get(siteId), now))
      return
    lastStamped.set(siteId, now)
    await query('UPDATE sites SET read_key_last_used_at = ? WHERE id = ?', [now.toISOString(), siteId])
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
