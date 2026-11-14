import type { ServerConfig } from '@stacksjs/types'

/**
 * **Server Configuration**
 *
 * Which requests the views server hands to the API. Routes under `/api` are
 * forwarded on their own; a route mounted at the root has to be named here,
 * or the views server answers it with the page 404.
 */
export default {
  proxy: {
    // The public badge and sparkline images: `/public/{siteId}/badge.svg`
    // and `/public/{siteId}/sparkline.svg`, embedded on other people's sites.
    prefixes: ['/public'],
    paths: [],
  },
} satisfies Partial<ServerConfig>
