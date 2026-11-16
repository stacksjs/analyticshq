import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectReadKeyName, SETTINGS_READ_KEY_NAME } from '../../app/Support/read-key'
import { isSiteToken, SITE_SCOPES, SITE_TOKEN_LIFETIME_DAYS, SITE_TOKEN_OWNER, siteTokenExpiry } from '../../app/Support/site-tokens'

const ROOT = join(import.meta.dir, '../..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

/** A token as the framework answers it, owned by a site's principal. */
const siteToken = (scopes: string[]) => ({ id: 7, subjectType: SITE_TOKEN_OWNER, subjectId: 3, scopes })

describe('isSiteToken', () => {
  test('a read key is a principal-owned token carrying the read scope', () => {
    expect(isSiteToken(siteToken([SITE_SCOPES.read]), SITE_SCOPES.read)).toBe(true)
  })

  test('a person\'s token is never a read key, whatever it carries', () => {
    expect(isSiteToken({ id: 1, subjectType: 'users', subjectId: 3, scopes: ['*'] }, SITE_SCOPES.read)).toBe(false)
    expect(isSiteToken({ id: 1, subjectType: 'users', subjectId: 3, scopes: [SITE_SCOPES.read] }, SITE_SCOPES.read)).toBe(false)
    expect(isSiteToken({ id: 1, subjectId: 3, scopes: [SITE_SCOPES.read] }, SITE_SCOPES.read)).toBe(false)
  })

  test('full access is not a site scope', () => {
    expect(isSiteToken(siteToken(['*']), SITE_SCOPES.read)).toBe(false)
    expect(isSiteToken(siteToken(['*', SITE_SCOPES.read]), SITE_SCOPES.read)).toBe(false)
  })

  test('nothing, another scope, and a token with no owner id are refused', () => {
    expect(isSiteToken(null, SITE_SCOPES.read)).toBe(false)
    expect(isSiteToken(undefined, SITE_SCOPES.read)).toBe(false)
    expect(isSiteToken(siteToken(['site:something-else']), SITE_SCOPES.read)).toBe(false)
    expect(isSiteToken({ id: 1, subjectType: SITE_TOKEN_OWNER, scopes: [SITE_SCOPES.read] }, SITE_SCOPES.read)).toBe(false)
  })
})

describe('a read key\'s life', () => {
  test('is the longest used here, because it runs unattended', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    expect(siteTokenExpiry(now).getTime() - now.getTime()).toBe(SITE_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000)
  })
})

describe('read key names', () => {
  test('a key given to a connected app is named after it', () => {
    expect(connectReadKeyName('cursio')).toBe('Connected: cursio')
    expect(connectReadKeyName('  my   app ')).toBe('Connected: my app')
    expect(connectReadKeyName('')).toBe('Connected app')
    expect(connectReadKeyName('x'.repeat(500)).length).toBeLessThanOrEqual('Connected: '.length + 100)
  })

  test('a key issued from the dashboard has a fixed name', () => {
    expect(SETTINGS_READ_KEY_NAME).toBe('Read key')
  })
})

/*
 * A read key is the framework's token, owned by the site. The app mints,
 * lists, resolves and revokes it through @stacksjs/auth and keeps no
 * credential of its own.
 */
describe('a read key is the framework\'s token', () => {
  const support = read('app/Support/site-tokens.ts')

  test('minted, listed, resolved and revoked through @stacksjs/auth', () => {
    expect(support).toContain('import { createToken, findToken, revokeTokenById, tokens } from \'@stacksjs/auth\'')
    expect(support).toContain('tokenableType: SITE_TOKEN_OWNER')
    expect(support).not.toMatch(/getRandomValues|createHash|randomUUID/)
  })

  test('the app keeps no key column, generator or comparison', () => {
    for (const file of ['app/Support/read-key.ts', 'app/Hq/adapter.ts', 'app/Hq/service.ts']) {
      const source = read(file)
      expect({ file, clean: !/getRandomValues|createHash|sameKey\(|\bread_key\b/.test(source) }).toEqual({ file, clean: true })
    }
    expect(read('app/Models/Site.ts')).not.toContain('read_key')
    expect(read('routes/analytics.ts')).not.toMatch(/UPDATE sites SET read_key|SELECT[^\n]*read_key/)
  })

  test('deleting a site revokes its read keys first', () => {
    const analytics = read('routes/analytics.ts')
    const handler = analytics.slice(analytics.indexOf('route.delete(\'/api/sites/{siteId}\', async'))
    expect(handler.indexOf('revokeSiteTokens(String(siteId), SITE_SCOPES.read)')).toBeLessThan(handler.indexOf('DELETE FROM sites WHERE id'))
  })
})
