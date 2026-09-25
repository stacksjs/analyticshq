import type { AuthConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

/**
 * **Authentication Configuration**
 *
 * This configuration defines all of your authentication options. Because Stacks is fully-typed,
 * you may hover any of the options below and the definitions will be provided. In case
 * you have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  enabled: true,

  /**
   * The authentication guard to use for your application.
   */
  default: 'api',

  /**
   * The authentication guards available for your application.
   */
  guards: {
    api: {
      driver: 'token',
      provider: 'users',
    },
  },

  /**
   * The authentication providers available for your application.
   */
  providers: {
    users: {
      driver: 'database',
      table: 'users',
    },
  },

  /**
   * The username field used for authentication.
   */
  username: env.AUTH_USERNAME_FIELD || 'email',

  /**
   * The password field used for authentication.
   */
  password: env.AUTH_PASSWORD_FIELD || 'password',

  /**
   * Access-token expiry in milliseconds (default: 7 days).
   *
   * This value IS the browser session length, not just an API-bearer TTL.
   * LoginAction mirrors the issued access token into the HttpOnly `auth-token`
   * cookie (see Support/authCookie.ts) because the dashboard is
   * server-rendered stx with no client hydration and has no other way to know
   * who is asking. Both the cookie's Max-Age and the
   * `oauth_access_tokens.expires_at` row are stamped from here, and nothing
   * extends either one - `getUserFromToken` bumps `updated_at` on every request
   * but leaves `expires_at` alone, then deletes the row once it passes. So a
   * signed-in operator is logged out exactly this long after login regardless
   * of activity.
   *
   * This is the BASELINE only. LoginAction and VerifyTwoFactorLoginAction pass
   * a per-login `expiresInMinutes` from the sign-in form's "remember me"
   * checkbox (see sessionExpiryMinutes in Support/authCookie.ts): a week
   * unchecked, 30 days checked. This default covers the entry points that have
   * no such checkbox - register, social sign-in, invite acceptance - so they
   * all land on the baseline week.
   *
   * It was 1h before (a sane API-bearer TTL but a hostile session, patched over
   * with a client-side refresh rotation). The uniform HQ model drops refresh
   * and makes the long-lived cookie the session; a week baseline with an opt-in
   * month is the "don't log me out" bar the other HQ apps already clear.
   * AUTH_TOKEN_EXPIRY overrides it per environment without a deploy.
   */
  tokenExpiry: env.AUTH_TOKEN_EXPIRY || 7 * 24 * 60 * 60 * 1000,

  /**
   * Refresh-token expiry in milliseconds (default: 30 days).
   *
   * NOT WIRED UP. The uniform HQ auth model has no refresh exchange - the
   * long-lived `auth-token` cookie IS the session. There is no /auth/refresh
   * route and no cookie stores a refresh token, so this value only bounds a row
   * in `oauth_refresh_tokens` that never gets read. Session length is
   * `tokenExpiry` above, alone.
   */
  refreshTokenExpiry: env.AUTH_REFRESH_TOKEN_EXPIRY || 30 * 24 * 60 * 60 * 1000,

  /**
   * The token rotation time in hours (default: 24 hours).
   */
  tokenRotation: env.AUTH_TOKEN_ROTATION || 24,

  /**
   * The token abilities that are granted by default.
   */
  defaultAbilities: ['*'],

  /**
   * The token name used when creating new tokens.
   */
  defaultTokenName: 'auth-token',

  // The auth cookie name is NOT overridden here. The custom auth actions
  // (Support/authCookie.ts) and app/Middleware/Auth.ts both resolve it
  // from `defaultTokenName` above ('auth-token'), so writer and reader agree on
  // one name. An app-specific `cookie: { name: ... }` override used to point the
  // framework writer at a different name than the middleware read, so the cookie
  // branch authenticated nothing - removed as part of the uniform-auth conversion.

  /**
   * Password reset configuration.
   */
  passwordReset: {
    /**
     * Token expiration time in minutes.
     * After this time, the reset link becomes invalid.
     *
     * @default 60
     */
    expire: env.AUTH_PASSWORD_RESET_EXPIRE ||60,

    /**
     * Throttle time in seconds between password reset requests.
     * Users must wait this long before requesting another reset email.
     *
     * @default 60
     */
    throttle: env.AUTH_PASSWORD_RESET_THROTTLE ||60,

    /**
     * Where the emailed reset link points. Pointed at OUR page on purpose.
     *
     * The framework default is `/password/reset/{token}?email={email}`
     * (@stacksjs/auth password/reset.js:72), which collides confusingly with the
     * POST API endpoint of the same name that routes/auth.ts registers: one is a
     * page a human opens, the other is JSON the page submits to, and they would
     * differ only by HTTP method and a trailing segment.
     *
     * {token} and {email} are substituted by the mailer; {email} is already
     * URL-encoded at substitution time, so it must not be encoded again here.
     */
    url: '/reset-password?token={token}&email={email}',
  },
} satisfies AuthConfig
