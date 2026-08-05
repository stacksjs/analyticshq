/**
 * The one owner of auth state. Replaces 18 hand-written localStorage calls and 6
 * hand-serialised document.cookie writes spread across login, register, account,
 * dashboard, pricing and sites/new.
 *
 * HOW THIS FILE IS LOADED (store-loader contract -- it is not a normal module):
 *   - resources/stores/ *.ts, top level only, non-recursive.
 *   - Every single-line `import ... from '...'` is DELETED before transpile. That is why
 *     this file imports NOTHING: its types come from types/session.d.ts as ambient
 *     declarations. A value import here would be stripped and throw ReferenceError at
 *     runtime with no build error; an import of a type would vanish just as quietly.
 *   - `export` is stripped and all store files are concatenated into ONE shared IIFE,
 *     so every top-level name here must be globally unique across resources/stores/.
 *   - state/derived/effect/useLocalStorage/navigate are runtime globals; do not import.
 *
 * ON THE MIGRATION BELOW (rewritten for stx 0.2.151 -- the earlier note here was true of
 * 0.2.146 and is not any more, so do not restore it):
 * useLocalStorage still JSON.stringifies on write, but the read path now goes through
 * stxParseStored, which on a parse failure WARNS and returns the raw string instead of
 * throwing. So a legacy raw token no longer breaks the page; it simply logs
 * `"token" holds a value that is not JSON` on every load until something rewrites it.
 * sessionMigrateRaw re-encodes it once so that warning never fires. That is now its only
 * job -- it is a papercut fix, not a crash guard.
 */

const SESSION_TOKEN_KEY = 'token'
const SESSION_USER_KEY = 'user'
const SESSION_REFRESH_KEY = 'refresh_token'
const SESSION_COOKIE = 'analyticshq_token'

/**
 * Reach useCookie through window.stx, and do NOT "simplify" this to a bare call.
 *
 * Client <script> blocks get a generated `var { useCookie, ... } = window.stx` preamble
 * from client-script.js. Store files do not: store-loader.js transpiles and concatenates
 * them without ever importing STX_RUNTIME_GLOBALS the way composable-loader.js does. So
 * inside a store only the symbols signals.js assigns to `window` directly resolve --
 * state, effect, batch, navigate, defineStore and useLocalStorage do; useCookie is one of
 * the ~34 that live solely on window.stx and is a bare ReferenceError here.
 *
 * That failure is silent in the worst way: the ReferenceError is thrown inside the store
 * IIFE, so defineStore never completes and useStore('session') reports "Store not found"
 * somewhere else entirely. Verified in a headless browser, not by reading the bundle.
 *
 * RESOLVED LAZILY, and that matters. Read at module scope this was
 * `globalThis.stx.useCookie` on the store bundle's first line -- which throws
 * `Cannot read properties of undefined` if the bundle ever executes before the signals
 * runtime has populated window.stx. The router re-runs page scripts on navigation, and
 * an ordering slip there turns one missing global into a dead store on every subsequent
 * page. A sibling app hit exactly that (`Cannot destructure property 'batch' of
 * 'window.stx' as it is undefined`), so this resolves inside the factory, which cannot
 * run before defineStore itself exists, and degrades to an in-memory signal rather than
 * throwing if the global is somehow still absent.
 */
type SessionCookieOpts = { maxAge?: number, sameSite?: 'Lax' | 'Strict' | 'None', path?: string }
type SessionCookieFn = (name: string, opts?: SessionCookieOpts) => StxSignal<string>

function sessionCookieSignal(name: string, opts: SessionCookieOpts): StxSignal<string> {
  const fn = (globalThis as any).stx?.useCookie as SessionCookieFn | undefined
  if (fn)
    return fn(name, opts)
  console.warn('[session] window.stx.useCookie unavailable; the server-readable cookie will not be mirrored this render.')
  return state('')
}

/** Re-encode a pre-migration raw value so useLocalStorage can parse it. */
function sessionMigrateRaw(key: string): void {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null)
      return
    try {
      JSON.parse(raw)
    }
    catch {
      // Not JSON -> written by the pre-store code path. Wrap it once.
      localStorage.setItem(key, JSON.stringify(raw))
    }
  }
  catch {
    // Safari private mode denies storage access; treat as signed out.
  }
}

sessionMigrateRaw(SESSION_TOKEN_KEY)
sessionMigrateRaw(SESSION_USER_KEY)
sessionMigrateRaw(SESSION_REFRESH_KEY)

defineStore('session', (): SessionStore => {
  // NOTE the shape of these two annotations. 0.2.151 declares
  // `useLocalStorage<T>(key, default): StxSignal<T>`, so the return type is inferred
  // from the DEFAULT -- and `null` alone infers StxSignal<null>, which cannot accept a
  // user. Widen the default rather than writing `useLocalStorage<SessionUser | null>(...)`:
  // for a client <script> block the generic form is a runtime bug, because auto-import
  // detection matches /\b<symbol>\s*\(/ on the raw source (client-script.js:400) and a
  // `<` where the `(` must be means the destructuring line is never emitted. Store files
  // are not scanned that way, but keeping one habit everywhere is cheaper than
  // remembering which files are exempt.
  const token: StxSignal<string> = useLocalStorage(SESSION_TOKEN_KEY, '')
  const user: StxSignal<SessionUser | null> = useLocalStorage(SESSION_USER_KEY, null as SessionUser | null)

  // The 30-day half of the pair. config/auth.ts:57 caps the ACCESS token at one hour,
  // and LoginAction has always returned a refresh token beside it -- the app simply
  // never read the field, so every session died on the hour and the visitor landed on
  // the signed-out gate while localStorage still held a token (#32).
  const refresh: StxSignal<string> = useLocalStorage(SESSION_REFRESH_KEY, '')

  // The dashboard and account pages render owner-scoped content on the SERVER, which
  // cannot read localStorage -- it authenticates from this cookie. useCookie owns the
  // serialisation (path, max-age, SameSite, and Secure derived from location.protocol),
  // which is the string four pages used to retype by hand and could drift on.
  const mirror: StxSignal<string> = sessionCookieSignal(SESSION_COOKIE, { maxAge: 2592000, sameSite: 'Lax' })

  // Keep the cookie in step with the token for the whole session rather than only at
  // sign-in: a visitor can arrive with a token in localStorage and no cookie (it
  // expired, or they signed in before this shipped), and the server render depends on
  // it. This is why no page needs an "ensure the cookie exists" block any more.
  effect(() => {
    const t = token()
    if (mirror() !== t)
      mirror.set(t)
  })

  function bearer(): Record<string, string> {
    const t = token()
    return t ? { Authorization: `Bearer ${t}` } : {}
  }

  // Declared up here rather than only on the returned object because authFetch calls
  // it directly when a refresh comes back refused.
  function signOut(): void {
    batch(() => {
      token.set('')
      user.set(null)
      refresh.set('')
    })
    navigate('/login')
  }

  /**
   * SINGLE-FLIGHT, and that is not an optimisation.
   *
   * The refresh token is single-use with rotation: /auth/refresh spends the one it is
   * given and returns a new pair. The dashboard fires several authenticated requests
   * at once (/api/me, the realtime poll, whatever the page is doing), so an expired
   * access token produces SEVERAL simultaneous 401s. Without this, each would exchange
   * the same token; the first wins and the rest are refused, which would sign the
   * visitor out in the middle of a session that had just successfully renewed.
   *
   * So every concurrent caller awaits one shared promise, and the slot is released
   * only after it settles.
   */
  let sessionRefreshInFlight: Promise<SessionRefreshOutcome> | null = null

  function refreshAccessToken(): Promise<SessionRefreshOutcome> {
    if (sessionRefreshInFlight)
      return sessionRefreshInFlight

    const spent = refresh()
    if (!spent)
      return Promise.resolve('unavailable' as SessionRefreshOutcome)

    const attempt = (async (): Promise<SessionRefreshOutcome> => {
      let res: Response
      try {
        res = await fetch('/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: spent }),
        })
      }
      catch {
        // Offline, or the request never left. A refresh that could not be ATTEMPTED is
        // not one that was refused -- returning 'refused' here would sign people out
        // every time their wifi blipped.
        return 'unavailable'
      }

      if (!res.ok)
        return 'refused'

      const data = await res.json().catch(() => null) as RefreshResponse | null
      if (!data || !data.access_token)
        return 'refused'

      batch(() => {
        token.set(data.access_token as string)
        // Rotation: the old refresh token is now spent. If the server ever stops
        // returning a new one, clear ours rather than keep replaying a dead value.
        refresh.set(data.refresh_token || '')
      })
      return 'ok'
    })()

    sessionRefreshInFlight = attempt
    attempt
      .catch(() => 'unavailable' as SessionRefreshOutcome)
      .then(() => {
        if (sessionRefreshInFlight === attempt)
          sessionRefreshInFlight = null
      })

    return attempt
  }

  return {
    token,
    user,
    isAuthed: () => !!token(),

    authHeaders: bearer,

    refreshAccessToken,

    async authFetch(input: string, init: RequestInit = {}): Promise<Response> {
      const send = () => fetch(input, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), ...bearer() },
      })

      const res = await send()
      if (res.status !== 401)
        return res

      const outcome = await refreshAccessToken()

      // 'refused' means the refresh token is spent or expired -- the session really is
      // over, so end it here instead of leaving the visitor on a page that looks signed
      // in and answers nothing. 'unavailable' covers both offline and the share-link
      // viewer who has no token at all and gets a legitimate 401: neither is a reason
      // to sign anyone out, so hand the 401 back and let the caller decide.
      if (outcome === 'refused') {
        signOut()
        return res
      }
      if (outcome === 'unavailable')
        return res

      return send()
    },

    signIn(next: string, nextUser: SessionUser | null = null, nextRefresh: string = '') {
      batch(() => {
        token.set(next)
        if (nextUser)
          user.set(nextUser)
        // Guarded: the social sign-in path hands over an access token only, and
        // clobbering a good refresh token with '' there would reintroduce the
        // one-hour death for exactly those users.
        if (nextRefresh)
          refresh.set(nextRefresh)
      })
    },

    signOut,
  }
})
