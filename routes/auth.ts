import { route } from '@stacksjs/router'

/**
 * Auth endpoints, re-registered at the root with `.skipCsrf()`.
 *
 * These use the framework's default Auth actions (resolved by string), but the
 * defaults are CSRF-gated — which blocks the same-origin `fetch()` from the
 * login/register pages. Token auth is CSRF-immune (bearer tokens aren't sent
 * automatically by the browser the way cookies are), so skipping CSRF here is
 * safe; the rate limits are kept. User route files load before the framework
 * defaults, so these win on the duplicate method+path.
 */
route.post('/login', 'Actions/Auth/LoginAction').skipCsrf().rateLimit(5, 'minute')
route.post('/register', 'Actions/Auth/RegisterAction').skipCsrf().rateLimit(3, 'minute')
route.post('/logout', 'Actions/Auth/LogoutAction').skipCsrf()

// Access tokens last one hour (config/auth.ts:57). Without this route the session
// simply ended there -- and not with a redirect to /login, but with the server
// rendering the signed-out gate while localStorage still held a token, so the
// pre-paint guard saw a truthy value and did not bounce (#32).
//
// The framework already registers POST /auth/refresh, but CSRF-gated like the login
// endpoints, which blocks the same-origin fetch from the session store for the same
// reason the three above are re-registered here. Bearer/refresh tokens are not sent
// automatically by the browser, so they are CSRF-immune; the rate limit stays, and it
// matters more here than anywhere else because a leaked refresh token is otherwise a
// renewable source of access tokens.
route.post('/auth/refresh', 'Actions/Auth/RefreshTokenAction').skipCsrf().rateLimit(10, 'minute')

/**
 * Password reset (#34).
 *
 * These had to be registered here, not merely enabled: NO framework default route is
 * mounted in this app. Verified by probing routes this file does not declare --
 * /verify-two-factor-login, /logout-all, /generate-two-factor-secret and /auth/tokens
 * all return 404. Only ACTIONS resolve from @stacksjs/defaults by string, which is why
 * the handlers below exist without a single file in app/Actions/Password/.
 *
 * That is also why the issue's premise ("the backend exists, nothing renders it") was
 * only half right: the actions existed, the routes did not.
 *
 * Rate limits mirror the framework's own for these endpoints. /forgot is the tightest
 * because it triggers a mailer hop, so it is the most abusable as an amplifier.
 *
 * NOTE the enumeration leak in SendPasswordResetEmailAction: it answers 404 "No account
 * found with this email address." for an unknown address and 200 for a known one, which
 * turns this into an account-existence oracle. Filed upstream. The forgot-password page
 * renders one neutral message for BOTH outcomes so the app does not pass the leak on --
 * see resources/views/forgot-password.stx.
 */
route.post('/password/forgot', 'Actions/Password/SendPasswordResetEmailAction').skipCsrf().rateLimit(3, 'minute')
route.post('/password/reset', 'Actions/Password/PasswordResetAction').skipCsrf().rateLimit(5, 'minute')
route.post('/password/verify-token', 'Actions/Password/VerifyResetTokenAction').skipCsrf().rateLimit(10, 'minute')

// GET API endpoints must sit under /api/** — the view process only reverse
// proxies non-GET requests and the /api/** prefix through to this API process.
// A bare GET like /me would be swallowed by the view server's page routing.
route.get('/api/me', 'Actions/MeAction').skipCsrf()

// Social sign-in (GitHub, Google) via the native @stacksjs/socials drivers.
// Under /api/** so the GET redirect + provider callback reach this process.
route.get('/api/auth/{provider}/redirect', 'Actions/Auth/SocialRedirectAction').skipCsrf()
route.get('/api/auth/{provider}/callback', 'Actions/Auth/SocialCallbackAction').skipCsrf()

// Billing (Stripe). Checkout requires an authenticated user (bearer token);
// the webhook is a Stripe callback so it skips CSRF and auth.
route.post('/payments/checkout', 'Actions/Payment/CreateCheckoutAction').middleware('auth').skipCsrf()
route.post('/webhooks/stripe', 'Actions/StripeWebhook').skipCsrf()
