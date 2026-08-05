/**
 * Session and auth shapes, as AMBIENT declarations (rule 10b: shared types live in
 * types/ and are never imported).
 *
 * This file deliberately contains no `import` and no `export`, which is what keeps it a
 * global script rather than a module -- every declaration below is visible everywhere
 * without a single import line. That matters most for resources/stores/*.ts: the store
 * loader DELETES every single-line import before transpiling, so a store that imported
 * its types would look correct in the editor and lose them at runtime.
 *
 * Worth knowing what these are worth: tsc cannot see inside .stx, so an annotation
 * written in a <script server> block is erased by the transpiler and verified by
 * nothing. Only .ts files on the tsconfig include path -- types/ and
 * resources/stores/ -- are actually checked. Treat a wrong annotation in a .stx file
 * as a real defect; no compiler will catch it for you.
 */

/** The authenticated user as /api/me returns it. */
interface SessionUser {
  id: string | number
  name: string
  email: string
  avatar?: string | null
  created_at?: string
}

/** Response body of GET /api/me. */
interface MeResponse {
  user: SessionUser
  pro?: boolean
}

/** Response body of POST /login and POST /register. */
interface AuthResponse {
  /** Legacy alias for access_token, still emitted by the framework's LoginAction. */
  token?: string
  access_token?: string
  /**
   * Single-use, rotating, 30-day. The framework has always returned this; the app
   * dropped it on the floor until #32, which is why every session died at the
   * one-hour access-token expiry.
   */
  refresh_token?: string
  /** Access-token lifetime in SECONDS (the access token, not the refresh token). */
  expires_in?: number
  user?: SessionUser
  message?: string
}

/** Response body of POST /auth/refresh. Carries no user — only a fresh token pair. */
interface RefreshResponse {
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
}

/**
 * Outcome of a refresh attempt. The three-way split is load-bearing: a refresh that
 * could not be ATTEMPTED (offline, no refresh token) must not sign the visitor out,
 * while one that was REFUSED means the refresh token is spent or expired and staying
 * signed in is a lie.
 */
type SessionRefreshOutcome = 'ok' | 'refused' | 'unavailable'

/** What the session store exposes to a page. */
interface SessionStore {
  /** Raw bearer token, '' when signed out. Backed by localStorage. */
  token: StxSignal<string>
  /** The signed-in user, or null. Backed by localStorage. */
  user: StxSignal<SessionUser | null>
  /** True when a token is present. */
  isAuthed: () => boolean
  /** Authorization header object for fetch(), empty when signed out. */
  authHeaders: () => Record<string, string>
  /**
   * fetch() with the bearer header attached, which transparently renews the access
   * token and retries ONCE when the server answers 401. Prefer this over calling
   * fetch() with authHeaders() by hand: the hand-written form is what made every
   * session die after an hour.
   */
  authFetch: (input: string, init?: RequestInit) => Promise<Response>
  /**
   * Exchange the refresh token for a new pair. Callers rarely need this — authFetch
   * does it for them. Concurrent calls share one in-flight request.
   */
  refreshAccessToken: () => Promise<SessionRefreshOutcome>
  /** Persist a fresh login; the cookie mirror follows via an effect in the store. */
  signIn: (token: string, user?: SessionUser | null, refreshToken?: string) => void
  /** Clear both stores, expire the cookie, and send the visitor to /login. */
  signOut: () => void
}
