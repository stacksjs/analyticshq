import { createToken, findToken, revokeTokenById, tokens } from '@stacksjs/auth'
import process from 'node:process'
import { db } from '@stacksjs/database'

/**
 * Tokens that act for a site: its read keys.
 *
 * They are Stacks personal access tokens owned by the site's principal
 * (app/Models/SitePrincipal.ts) instead of by a user. Everything about the
 * credential is the framework's: `createToken` mints it and keeps only a
 * hash, `findToken` answers whether it is live, `tokens` lists a principal's,
 * `revokeTokenById` ends one (@stacksjs/auth). This file adds the two things
 * the framework cannot know: which principal stands for which site, and
 * which scope a route is asking for.
 *
 * A site token names what it may do, and the principal says to which
 * site. It grants nothing else and it is nobody's session: the framework
 * resolves only `users` tokens to a user, so no route that asks for a person
 * can be opened with one.
 */

/** The table whose rows own site tokens: `tokenable_type` for all of them. */
export const SITE_TOKEN_OWNER = 'site_principals'

export const SITE_SCOPES = {
  /** Read this site's analytics: what a read key carries. */
  read: 'site:read',
} as const

export type SiteScope = typeof SITE_SCOPES[keyof typeof SITE_SCOPES]

/**
 * How long a site token lasts.
 *
 * It sits in another system's configuration (a dashboard's server) and is
 * used unattended, so it is given the longest life used here
 * rather than one that breaks a deployment on an anniversary. It is revocable
 * at any point.
 */
export const SITE_TOKEN_LIFETIME_DAYS = 3650

export function siteTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + SITE_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000)
}

/** The fields of a framework token this file reads. */
export interface TokenFacts {
  id: number
  subjectType?: string
  subjectId?: number
  scopes: readonly string[]
}

/**
 * Whether a live token is a site token carrying `scope`.
 *
 * Owned by a principal, never by a user, and naming the scope itself: `*` is
 * what a sign-in carries and is not accepted as a site scope, so a session
 * can never be presented where a site token is asked for.
 */
export function isSiteToken(token: TokenFacts | null | undefined, scope: SiteScope): token is TokenFacts & { subjectId: number } {
  return !!token
    && token.subjectType === SITE_TOKEN_OWNER
    && Number.isSafeInteger(token.subjectId)
    && !token.scopes.includes('*')
    && token.scopes.includes(scope)
}

const IS_PG = (process.env.DB_CONNECTION ?? 'postgres') === 'postgres'
type Row = Record<string, unknown>

/** Written with `?` and bound as `$n` on Postgres, as routes/analytics.ts does. */
function query(sql: string, params: unknown[] = []): Promise<Row[]> {
  let i = 0
  return db.unsafe(IS_PG ? sql.replace(/\?/g, () => `$${++i}`) : sql, params)
}

/** The principal that stands for a site, created the first time it is needed. */
export async function principalId(siteId: string): Promise<number> {
  const existing = (await query('SELECT id FROM site_principals WHERE site_id = ? LIMIT 1', [siteId]))?.[0]
  if (existing)
    return Number(existing.id)
  // Two requests creating it at once is settled by the unique index: the loser
  // inserts nothing and reads the winner's row.
  const now = new Date().toISOString()
  await query(
    'INSERT INTO site_principals (site_id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT (site_id) DO NOTHING',
    [siteId, now, now],
  )
  const created = (await query('SELECT id FROM site_principals WHERE site_id = ? LIMIT 1', [siteId]))?.[0]
  if (!created)
    throw new Error(`No principal for site ${siteId}`)
  return Number(created.id)
}

export interface SiteTokenView {
  id: string
  name: string
  created_at: string
  expires_at: string | null
}

/** Mint a token for a site. The plaintext is in this answer and nowhere afterwards. */
export async function mintSiteToken(siteId: string, scope: SiteScope, name: string): Promise<{ token: string, id: string }> {
  const owner = await principalId(siteId)
  // One scope, and no refresh token: a site token is replaced by minting
  // another, and a refresh credential would be a second secret nobody uses.
  const created = await createToken(owner, name, [scope], {
    tokenableType: SITE_TOKEN_OWNER,
    expiresAt: siteTokenExpiry(),
    withRefreshToken: false,
  })
  return { token: created.plainTextToken, id: String(created.accessToken.id) }
}

/** A site's live tokens carrying `scope`, newest first. */
export async function siteTokens(siteId: string, scope: SiteScope): Promise<SiteTokenView[]> {
  const owner = (await query('SELECT id FROM site_principals WHERE site_id = ? LIMIT 1', [siteId]))?.[0]
  if (!owner)
    return []
  const now = Date.now()
  return (await tokens(Number(owner.id), SITE_TOKEN_OWNER))
    .filter(token => isSiteToken({ ...token, subjectType: SITE_TOKEN_OWNER, subjectId: Number(owner.id) }, scope))
    .filter(token => token.expiresAt == null || token.expiresAt.getTime() > now)
    .map(token => ({
      id: String(token.id),
      name: token.name,
      created_at: token.createdAt.toISOString(),
      expires_at: token.expiresAt ? token.expiresAt.toISOString() : null,
    }))
}

/**
 * Revoke one of a site's tokens. The id is looked up among that site's
 * tokens for the scope rather than trusted, so an id from another site, or
 * a person's session, revokes nothing. Answers whether anything was revoked.
 */
export async function revokeSiteToken(siteId: string, scope: SiteScope, tokenId: unknown): Promise<boolean> {
  const wanted = String(tokenId ?? '')
  const owned = (await siteTokens(siteId, scope)).find(token => token.id === wanted)
  if (!owned)
    return false
  await revokeTokenById(Number(owned.id))
  return true
}

/** Revoke every token a site holds for `scope`. Answers how many. */
export async function revokeSiteTokens(siteId: string, scope: SiteScope): Promise<number> {
  const held = await siteTokens(siteId, scope)
  for (const token of held)
    await revokeTokenById(Number(token.id))
  return held.length
}

export interface SiteTokenTarget {
  siteId: string
  tokenId: string
  /** The account the site belongs to, or null when it has none. */
  ownerId: number | null
  isActive: boolean
}

/**
 * The site a presented bearer acts for, when it is a live site token
 * carrying `scope`. Null otherwise: not a token, revoked, expired, a person's
 * token, a token for another scope, or one whose site is gone.
 */
export async function siteForToken(presented: string, scope: SiteScope): Promise<SiteTokenTarget | null> {
  if (!presented)
    return null
  let token: TokenFacts | null
  try {
    token = await findToken(presented)
  }
  catch {
    return null
  }
  if (!isSiteToken(token, scope))
    return null
  const row = (await query(
    `SELECT s.id, s.owner_id, s.is_active FROM site_principals sp JOIN sites s ON s.id = sp.site_id
     WHERE sp.id = ? LIMIT 1`,
    [token.subjectId],
  ))?.[0]
  if (!row)
    return null
  return {
    siteId: String(row.id),
    tokenId: String(token.id),
    ownerId: row.owner_id == null ? null : Number(row.owner_id),
    isActive: !(row.is_active === false || row.is_active === 0),
  }
}
