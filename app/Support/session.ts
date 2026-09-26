/**
 * Who is signed in, for server-rendered pages.
 *
 * Returns the shape stx's `@auth` / `@guest` directives read from the render
 * context (`auth.check`, `auth.user`), so a page or layout does
 *
 *   const auth = await sessionFrom(typeof cookies !== 'undefined' ? cookies : {})
 *
 * and its template can use the directives directly. The session is the
 * HttpOnly `auth-token` cookie LoginAction sets, resolved with @stacksjs/auth
 * the same way the dashboard does. No cookie means no lookup, so a signed-out
 * visitor costs nothing.
 *
 * Only the name and email are exposed: the template needs no more, and a
 * field that is not here cannot end up in a page.
 */

export interface PageSession {
  check: boolean
  user: { name: string, email: string } | null
}

const SIGNED_OUT: PageSession = { check: false, user: null }

export async function sessionFrom(cookies: Record<string, string | undefined> | null | undefined): Promise<PageSession> {
  const token = cookies?.['auth-token'] || ''
  if (!token)
    return SIGNED_OUT
  try {
    const { Auth } = await import('@stacksjs/auth')
    const viewer = await Auth.getUserFromToken(token)
    if (!viewer)
      return SIGNED_OUT
    return { check: true, user: { name: String((viewer as any).name || ''), email: String((viewer as any).email || '') } }
  }
  catch {
    return SIGNED_OUT
  }
}
