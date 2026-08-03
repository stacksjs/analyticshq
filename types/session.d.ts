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
  token?: string
  access_token?: string
  user?: SessionUser
  message?: string
}

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
  /** Persist a fresh login; the cookie mirror follows via an effect in the store. */
  signIn: (token: string, user?: SessionUser | null) => void
  /** Clear both stores, expire the cookie, and send the visitor to /login. */
  signOut: () => void
}
