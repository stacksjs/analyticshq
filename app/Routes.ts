/**
 * Route Registry
 *
 * The key becomes the URL prefix; an explicit `prefix: ''` mounts a route
 * file at the root. This is an analytics-only app, so we register just the
 * analyticshq ingest + stats API — whose paths are already absolute
 * (`/collect`, `/health`, `/script.js`, `/api/sites/*`) — at the root.
 *
 * (We intentionally do NOT spread the framework demo defaults `api`/`v1`;
 * those scaffold route files were removed.)
 *
 * @see https://docs.stacksjs.org/routing
 */
import type { RouteRegistry } from '@stacksjs/router'

export type { RouteDefinition, RouteRegistry } from '@stacksjs/router'

export default {
  analytics: { path: 'analytics', prefix: '' },
  auth: { path: 'auth', prefix: '' },
} satisfies RouteRegistry
