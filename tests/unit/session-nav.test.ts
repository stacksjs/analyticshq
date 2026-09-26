/**
 * The signed-in state on server-rendered pages.
 *
 * A signed-in reader used to see "Log in" and "Sign up" in the marketing nav,
 * and a sign-in form on /login. The session is resolved once per render
 * (app/Support/session.ts) into the shape stx's @auth / @guest directives read.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionFrom } from '../../app/Support/session'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('sessionFrom', () => {
  test('no cookie is signed out, without a lookup', async () => {
    expect(await sessionFrom({})).toEqual({ check: false, user: null })
    expect(await sessionFrom(null)).toEqual({ check: false, user: null })
    expect(await sessionFrom({ 'auth-token': '' })).toEqual({ check: false, user: null })
  })

  test('exposes the name and email and nothing else', () => {
    const src = read('app/Support/session.ts')
    expect(src).toContain(`user: { name: String(viewer.name || ''), email: String(viewer.email || '') }`)
    expect(src).not.toMatch(/password|token:|is_platform_admin/)
  })
})

describe('the pages use it', () => {
  test('the marketing layout resolves the session for every page', () => {
    expect(read('resources/layouts/marketing.stx')).toContain(`const auth = await sessionFrom(typeof cookies !== 'undefined' ? cookies : {})`)
  })

  test('the nav offers the dashboard to a signed-in reader, in both menus', () => {
    const nav = read('resources/components/SiteNav.stx')
    expect((nav.match(/^\s*@auth\s*$/gm) ?? []).length).toBe(2)
    expect((nav.match(/^\s*@endauth\s*$/gm) ?? []).length).toBe(2)
    const open = nav.search(/^\s*@auth\s*$/m)
    const signedIn = nav.slice(open, nav.indexOf('@else', open))
    expect(signedIn).toContain('to="/dashboard"')
    expect(signedIn).not.toContain('to="/login"')
  })

  test('/login and /register show a signed-in reader the way out, not a form', () => {
    for (const page of ['resources/views/login.stx', 'resources/views/register.stx']) {
      const src = read(page)
      expect(src).toContain(`const auth = await sessionFrom(typeof cookies !== 'undefined' ? cookies : {})`)
      const panel = src.slice(src.indexOf('@auth\n'), src.indexOf('@else\n', src.indexOf('@auth\n')))
      expect(panel).toContain('data-signed-in')
      expect(panel).toContain('to="/dashboard"')
      expect(panel).not.toContain('<form')
      expect(src.trimEnd().endsWith('@endauth\n@endsection')).toBe(true)
    }
  })
})
