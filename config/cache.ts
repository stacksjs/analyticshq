import type { CacheConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

/**
 * **Cache Configuration**
 *
 * analyticshq stores its analytics in PostgreSQL, which has no cache-table
 * driver here, so the cache defaults to in-process `memory` — one fewer
 * service to run for a single-box app. Set
 * `CACHE_DRIVER=redis` (with the redis block below) when a shared cache across
 * instances is needed in production.
 */
export default {
  /**
   * The cache driver to use ('memory' | 'redis')
   */
  driver: env.CACHE_DRIVER || 'memory',

  /**
   * Key prefix for cache namespacing
   */
  prefix: 'stacks',

  /**
   * Default TTL in seconds (0 = no expiration)
   */
  ttl: 3600,

  /**
   * Maximum number of keys (-1 = unlimited)
   */
  maxKeys: -1,

  /**
   * Clone values on get/set (disable for better performance with immutable data)
   */
  useClones: true,

  drivers: {
    /**
     * Memory driver configuration
     */
    memory: {
      maxKeys: -1,
      checkPeriod: 600,
      deleteOnExpire: true,
    },

    /**
     * Redis driver configuration
     */
    redis: {
      host: '127.0.0.1',
      port: 6379,
      username: '',
      password: '',
      database: 0,
      tls: false,
    },
  },
} satisfies CacheConfig
