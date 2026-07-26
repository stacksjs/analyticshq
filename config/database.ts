import type { DatabaseConfig } from '@stacksjs/types'
import type { SupportedDialect } from 'bun-query-builder'
import process from 'node:process'
import { env } from '@stacksjs/env'
/**
 * **Database Configuration**
 *
 * This configuration defines all of your database options. Because Stacks is fully-typed,
 * you may hover any of the options below and the definitions will be provided. In case
 * you have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  // Postgres is the analytics store (see infrastructure.appDatabase in
  // config/cloud.ts). It is also the default so a missing DB_CONNECTION cannot
  // silently fall back to a local SQLite file and look healthy while writing
  // every pageview somewhere the dashboard never reads.
  default: env.DB_CONNECTION as SupportedDialect || 'postgres',

  connections: {
    sqlite: {
      // SQLite requires a file path, not a database name
      database: env.DB_DATABASE_PATH || 'database/stacks.sqlite',
      prefix: '',
    },

    mysql: {
      name: env.DB_DATABASE || 'stacks',
      host: env.DB_HOST || '127.0.0.1',
      port: env.DB_PORT ||3306,
      username: env.DB_USERNAME || 'root',
      password: env.DB_PASSWORD || '',
      prefix: '',
    },

    postgres: {
      name: env.DB_DATABASE || 'stacks',
      host: env.DB_HOST || '127.0.0.1',
      port: env.DB_PORT ||5432,
      username: env.DB_USERNAME || '',
      password: env.DB_PASSWORD || '',
      prefix: '',
    },
  },

  migrations: 'migrations',
  migrationLocks: 'migration_locks',

  /**
   * Query Logging Configuration
   *
   * This section configures the database query monitoring system.
   */
  queryLogging: {
    /**
     * Enable query logging to database
     */
    enabled: env.DB_QUERY_LOGGING_ENABLED ?? true,

    /**
     * The threshold in milliseconds to mark a query as slow
     */
    slowThreshold: env.DB_QUERY_LOGGING_SLOW_THRESHOLD || 100,

    /**
     * How many days to keep query logs
     */
    retention: env.DB_QUERY_LOGGING_RETENTION_DAYS || 7,

    /**
     * How often to run the pruning job in hours
     */
    pruneFrequency: env.DB_QUERY_LOGGING_PRUNE_FREQUENCY || 24,

    /**
     * Patterns to exclude from logging
     */
    excludedQueries: [
      // Don't log the query_logs table itself to avoid recursion
      'query_logs',
    ],

    /**
     * Query analysis configuration
     */
    analysis: {
      /**
       * Enable detailed query analysis
       */
      enabled: env.DB_QUERY_LOGGING_ANALYSIS_ENABLED ?? true,

      /**
       * Analyze all queries, not just slow ones
       */
      analyzeAll: env.DB_QUERY_LOGGING_ANALYZE_ALL ?? false,

      /**
       * Collect EXPLAIN plans for SELECT queries
       */
      explainPlan: env.DB_QUERY_LOGGING_EXPLAIN_PLAN ?? true,

      /**
       * Generate optimization suggestions
       */
      suggestions: env.DB_QUERY_LOGGING_SUGGESTIONS ?? true,
    },
  },
} satisfies DatabaseConfig
