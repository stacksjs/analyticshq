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
 */
type SessionCookieOpts = { maxAge?: number, sameSite?: 'Lax' | 'Strict' | 'None', path?: string }
const sessionUseCookie = (globalThis as any).stx.useCookie as (name: string, opts?: SessionCookieOpts) => StxSignal<string>

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

  // The dashboard and account pages render owner-scoped content on the SERVER, which
  // cannot read localStorage -- it authenticates from this cookie. useCookie owns the
  // serialisation (path, max-age, SameSite, and Secure derived from location.protocol),
  // which is the string four pages used to retype by hand and could drift on.
  const mirror: StxSignal<string> = sessionUseCookie(SESSION_COOKIE, { maxAge: 2592000, sameSite: 'Lax' })

  // Keep the cookie in step with the token for the whole session rather than only at
  // sign-in: a visitor can arrive with a token in localStorage and no cookie (it
  // expired, or they signed in before this shipped), and the server render depends on
  // it. This is why no page needs an "ensure the cookie exists" block any more.
  effect(() => {
    const t = token()
    if (mirror() !== t)
      mirror.set(t)
  })

  return {
    token,
    user,
    isAuthed: () => !!token(),

    authHeaders(): Record<string, string> {
      const t = token()
      return t ? { Authorization: `Bearer ${t}` } : {}
    },

    signIn(next: string, nextUser: SessionUser | null = null) {
      batch(() => {
        token.set(next)
        if (nextUser)
          user.set(nextUser)
      })
    },

    signOut() {
      batch(() => {
        token.set('')
        user.set(null)
      })
      navigate('/login')
    },
  }
})
