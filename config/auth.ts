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
   * Access-token expiry in milliseconds (default: 1 hour).
   *
   * Access tokens are deliberately short-lived: a leaked bearer (logs,
   * proxy, browser storage) is then usable for an hour, not a month. The
   * paired refresh token (`refreshTokenExpiry`) carries the long-lived
   * session and is rotated on use, so UX is unaffected.
   */
  tokenExpiry: env.AUTH_TOKEN_EXPIRY || 60 * 60 * 1000,

  /**
   * Refresh-token expiry in milliseconds (default: 30 days). This is the
   * long-lived credential exchanged for fresh access tokens.
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

  /**
   * The auth cookie (#33).
   *
   * `LoginAction` sets this server-side on sign-in and `LogoutAction` clears it,
   * both as of stacks 0.70.369 (stacksjs/stacks#2306). Naming it here is what
   * makes the framework's writer and this app's reader agree: the dashboard's
   * `<script server>` block authenticates from `cookies.analyticshq_token`, and
   * before this key existed the framework wrote a different name entirely — a
   * cookie it wrote was never one anything read.
   *
   * Note `defaultTokenName` above is NOT this. It is a personal-access-token
   * label; the framework honours it as a cookie name only for apps that had
   * renamed it before `cookie.name` existed, and warns when the label is not a
   * legal cookie name — which a human-readable label usually is not.
   *
   * The cookie is HttpOnly and the framework hardcodes that, which is the right
   * answer and the reason this change DELETED code rather than adding it: an
   * HttpOnly cookie cannot be written from `document.cookie`, so the session
   * store's mirror effect and the dashboard's pre-paint bootstrap were both
   * doing work the browser was refusing to let them do.
   */
  cookie: {
    name: 'analyticshq_token',
  },

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
