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
 * tsc cannot see inside .stx. The templates are checked against this file by
 * `bun run typecheck:views` instead, which hands it to `stx typecheck` with `--lib`
 * (and runs in CI beside tsc), so an annotation in a .stx block is verified too.
 */

/** The authenticated user as /api/me returns it. */
interface SessionUser {
  id: string | number
  name: string
  email: string
  avatar?: string | null
  provider?: string | null
  created_at?: string
}

/** Response body of GET /api/me. */
interface MeResponse {
  user: SessionUser
  pro?: boolean
  /** Runs the install: every site, every feature, never billed (app/Analytics/access.ts). */
  platformAdmin?: boolean
}

/**
 * Response body of POST /login, POST /register and POST /verify-two-factor-login.
 *
 * Under the uniform HQ auth model the real credential is the HttpOnly `auth-token`
 * cookie the action sets; the token in the body is informational (the client only
 * checks that a session was issued, then navigates so the SSR page reads the
 * cookie). A 2FA-enabled account gets `requires_two_factor` + `challenge_token`
 * instead of a session, and completes at POST /verify-two-factor-login.
 */
interface AuthResponse {
  /** Legacy alias for access_token, emitted alongside it by LoginAction. */
  token?: string
  access_token?: string
  /** Access-token lifetime in SECONDS. */
  expires_in?: number
  /** Present (true) when the account has 2FA enabled and a code is still required. */
  requires_two_factor?: boolean
  /** Single-use challenge to post back with the TOTP code, when 2FA is required. */
  challenge_token?: string
  user?: SessionUser
  message?: string
}
