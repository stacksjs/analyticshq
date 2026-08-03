/**
 * Session and auth shapes shared by the session store and the views that read it.
 *
 * These live here rather than inline in a .stx file for a concrete reason: tsc never
 * sees .stx at all (`tsc --listFilesOnly | grep .stx` returns nothing), so an
 * annotation written inside a <script server> block is erased by Bun.Transpiler and
 * verified by nothing. A type is only actually checked if it is declared in a .ts file
 * that is on the tsconfig `include` path -- which types/ and resources/stores/ now are.
 */

/** The authenticated user as /api/me returns it. */
export interface SessionUser {
  id: string | number
  name: string
  email: string
  avatar?: string | null
  created_at?: string
}

/** Response body of GET /api/me. */
export interface MeResponse {
  user: SessionUser
  pro?: boolean
}

/** Response body of POST /login and POST /register. */
export interface AuthResponse {
  token?: string
  access_token?: string
  user?: SessionUser
  message?: string
}

/** What the session store exposes to a page. */
export interface SessionStore {
  /** Raw bearer token, '' when signed out. Backed by localStorage. */
  token: StxSignal<string>
  /** The signed-in user, or null. Backed by localStorage. */
  user: StxSignal<SessionUser | null>
  /** True when a token is present. */
  isAuthed: () => boolean
  /** Authorization header object for fetch(), empty when signed out. */
  authHeaders: () => Record<string, string>
  /** Persist a fresh login and mirror the token to the server-readable cookie. */
  signIn: (token: string, user?: SessionUser | null) => void
  /** Clear both stores, expire the cookie, and send the visitor to /login. */
  signOut: () => void
}
