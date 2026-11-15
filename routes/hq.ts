/**
 * analyticshq: the HQ connect and usage endpoints (`@stacksjs/hq/service`).
 *
 *   POST /api/cli/connect                 -> { code, approveUrl, confirmCode }
 *   GET  /api/cli/connect/{code}          -> pending | approved + site id and read key (once) | expired
 *   GET  /api/v1/usage      (read key)    -> [{ meter, used, limit, period, state, upgradeUrl }]
 *   POST /api/cli/connect/{code}/approve  -> the approve page's action (signed-in user)
 *
 * `buddy hq:connect analyticshq` drives the first two. All of them live under
 * /api because the views server forwards only /api/* and mutating methods to
 * this backend (see routes/analytics.ts).
 */

import type { HqRequest } from '@stacksjs/hq/service'
import { confirmationCode, confirmationMatches } from '@stacksjs/hq/service'
import { route } from '@stacksjs/router'
import { rateLimit } from '../app/Hq/limits'
import { hq } from '../app/Hq/service'
import { sameOrigin } from '../app/Support/origin'

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    // Codes and keys travel in these bodies: nothing may keep one.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  })
}

/** What the handlers below read off the router's request. */
interface RouterRequest {
  url: string
  method?: string
  headers: Headers
  params?: Record<string, string | undefined>
  jsonBody?: Record<string, unknown> | null
  _authenticatedUser?: unknown
}

/**
 * The router has already read the body into `jsonBody`, so the stream the
 * package would call `json()` on is spent. Hand it what was parsed.
 */
function hqRequest(request: RouterRequest): HqRequest {
  return {
    url: String(request.url),
    method: request.method,
    headers: request.headers,
    params: request.params,
    json: async () => request.jsonBody ?? {},
  }
}

/** The signed-in user the auth middleware stamped on the request, or null. */
function userId(request: RouterRequest): number | null {
  const user = request._authenticatedUser
  if (typeof user !== 'object' || user === null || !('id' in user))
    return null
  const id = Number((user as { id: unknown }).id)
  return Number.isFinite(id) ? id : null
}

// Anyone can ask for a code, and each one is a row until it expires ten
// minutes later. Ten a minute per address is far more than a CLI needs and
// bounds what a script can pile up.
route.post('/api/cli/connect', async (request: RouterRequest) => {
  // `confirmCode` is what the CLI prints and the approve page asks for, the
  // same on every HQ service (`@stacksjs/hq` confirm). It goes only to the
  // caller that asked for the code, never into the approve URL.
  const started = await hq.startConnect(hqRequest(request))
  if (started.status !== 201)
    return started
  const body = await started.json() as { code: string, approveUrl: string, confirmCode?: string }
  return json({ ...body, confirmCode: body.confirmCode ?? await confirmationCode(body.code) }, 201)
}).skipCsrf().rateLimit(10, 'minute') // called by a CLI: no browser, no cookie, nothing to forge

// A CLI polls about once every two seconds while the person approves.
route.get('/api/cli/connect/{code}', (request: RouterRequest) =>
  hq.pollConnect(hqRequest(request), String(request.params?.code ?? ''))).rateLimit(120, 'minute')

route.get('/api/v1/usage', (request: RouterRequest) => hq.usage(hqRequest(request)))

// The approve page's button. Cookie-authenticated, so it checks the Origin:
// approving hands a site's read key to whoever holds the code, which is
// exactly what a forged cross-site POST would want.
//
// It also needs the confirmation code from the terminal that started the
// connect, checked here and not only in the page, so no request approves
// without it. Wrong guesses are limited per person: six characters at ten
// tries a minute cannot be guessed within the ten minutes a connect lives.
const APPROVE_LIMIT = 10
const APPROVE_WINDOW_MS = 60_000

route.post('/api/cli/connect/{code}/approve', async (request: RouterRequest) => {
  if (!sameOrigin(request))
    return json({ error: 'forbidden' }, 403)
  const id = userId(request)
  if (id === null)
    return json({ error: 'unauthorized' }, 401)

  const limit = rateLimit(`hq-approve:${id}`, APPROVE_LIMIT, APPROVE_WINDOW_MS)
  if (!limit.ok)
    return json({ error: 'Too many attempts. Wait a minute and try again.' }, 429, { 'Retry-After': String(limit.retryAfter) })

  const code = String(request.params?.code ?? '')
  if (!await confirmationMatches(code, request.jsonBody?.confirm)) {
    return json({
      error: 'That code does not match. Enter the confirmation code your terminal is showing.',
      reason: 'confirmation_mismatch',
    }, 422)
  }

  try {
    const result = await hq.approveConnect(code, { id })
    if (!result.ok) {
      return json({
        error: result.reason === 'already_approved'
          ? 'This connection was already approved.'
          : 'This connection request has expired. Run the command again.',
        reason: result.reason,
      }, result.reason === 'already_approved' ? 409 : 410)
    }
    return json({ ok: true, project: result.project })
  }
  catch (error) {
    console.error('[hq] could not approve connect:', error instanceof Error ? error.message : error)
    return json({ error: 'Could not approve the connection. Please try again.' }, 500)
  }
}).middleware('auth').skipCsrf()
