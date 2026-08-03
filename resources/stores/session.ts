import type { SessionStore, SessionUser } from '~/types/session'

/**
 * The one owner of auth state. Replaces 18 hand-written localStorage calls and 6
 * hand-serialised document.cookie writes spread across login, register, account,
 * dashboard, pricing and sites/new.
 *
 * HOW THIS FILE IS LOADED (store-loader contract -- it is not a normal module):
 *   - resources/stores/ *.ts, top level only, non-recursive.
 *   - Every single-line `import ... from '...'` is DELETED before transpile, so the
 *     `import type` above is author-time only. Never add a VALUE import here; it would
 *     be stripped and throw ReferenceError at runtime with no build error.
 *   - `export` is stripped and all store files are concatenated into ONE shared IIFE,
 *     so every top-level name here must be globally unique across resources/stores/.
 *   - state/derived/effect/useLocalStorage/navigate are runtime globals; do not import.
 *
 * THE MIGRATION BELOW IS LOAD-BEARING -- do not delete it.
 * useLocalStorage JSON.parses on read and JSON.stringifies on write (signals.js:4574).
 * Every existing client wrote the token RAW (`localStorage.setItem('token', token)`),
 * so handing that key straight to useLocalStorage would JSON.parse a bare JWT and throw
 * SyntaxError for every already-signed-in visitor. We re-encode the legacy value once,
 * before the signal is created.
 */

const SESSION_TOKEN_KEY = 'token'
const SESSION_USER_KEY = 'user'
const SESSION_COOKIE = 'analyticshq_token'

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
  // NOTE the shape of these two annotations. `useLocalStorage<SessionUser | null>(...)`
  // would be the obvious way to type them and it BREAKS: auto-import detection matches
  // /\b<symbol>\s*\(/ on the raw source (client-script.js:400), so a `<` where the `(`
  // must be means the symbol is never detected, no destructuring is emitted, and the
  // call throws ReferenceError at runtime with no build error. Annotate the binding --
  // or cast it, where the default value makes inference too narrow -- never the call.
  const token: StxSignal<string> = useLocalStorage(SESSION_TOKEN_KEY, '')
  const user = useLocalStorage(SESSION_USER_KEY, null) as StxSignal<SessionUser | null>

  // The dashboard and account pages render owner-scoped content on the SERVER, which
  // cannot read localStorage -- it authenticates from this cookie. Keeping the mirror
  // inside the store means the four pages that used to hand-serialise it no longer can
  // drift on path/max-age/samesite/secure.
  function sessionWriteCookie(value: string): void {
    const secure = location.protocol === 'https:' ? '; secure' : ''
    document.cookie = value
      ? `${SESSION_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=2592000; samesite=lax${secure}`
      : `${SESSION_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`
  }

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
      sessionWriteCookie(next)
    },

    signOut() {
      batch(() => {
        token.set('')
        user.set(null)
      })
      sessionWriteCookie('')
      navigate('/login')
    },
  }
})
