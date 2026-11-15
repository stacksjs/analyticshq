import { config } from '@stacksjs/config'
import { normalizeOrigin } from '../Analytics/install'

/**
 * Is this request's `Origin` one of ours?
 *
 * A guard for a cookie-authenticated POST whose effect is worth forging: a
 * browser attaches `Origin` to every cross-site POST, so refusing the ones
 * that are not ours stops a third-party page driving the endpoint with the
 * visitor's session. A request with no `Origin` at all is let through,
 * because that is what a server to server call and curl look like, and the
 * endpoint behind this still requires a session.
 *
 * Compared against configuration and not the Host header: behind the proxy
 * the app sees the upstream's host, never the public one, so the two could
 * never match. `config.app.url` is the statement of who this application is,
 * and every absolute link is already built from it.
 *
 * `www.` is accepted alongside the bare host, since an `Origin` can carry
 * either form.
 */
export function sameOrigin(request: { headers?: { get?: (name: string) => string | null } }, configured: string = String(config.app?.url || '')): boolean {
  const origin = request.headers?.get?.('origin')
  if (!origin)
    return true

  let originHost: string
  try {
    originHost = new URL(origin).host
  }
  catch {
    // A malformed Origin is not something any browser of ours sent.
    return false
  }

  let host: string
  try {
    host = new URL(normalizeOrigin(configured)).host
  }
  catch {
    // Nothing configured to compare against: refuse rather than accept anyone.
    return false
  }
  const bare = host.startsWith('www.') ? host.slice(4) : host
  return originHost === bare || originHost === `www.${bare}`
}
