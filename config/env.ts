import type { EnvConfig } from '@stacksjs/env'
import { schema } from '@stacksjs/validation'

/**
 * **Env Configuration & Validations**
 *
 * This configuration defines all of your Env validations. Because Stacks is fully-typed, you
 * may hover any of the options below and the definitions will be provided. In case you
 * have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  APP_NAME: {
    validation: schema.string(),
    default: 'Stacks',
  },

  APP_ENV: {
    validation: schema.enum(['local', 'dev', 'stage', 'prod']),
    default: 'local',
  },

  APP_KEY: {
    validation: schema.string(),
    default: 'base64:1234567890',
  },

  PORT: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_BACKEND: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_ADMIN: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_LIBRARY: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_DESKTOP: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_EMAIL: {
    validation: schema.number(),
    default: 3000,
  },
  PORT_DOCS: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_INSPECT: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_API: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_SYSTEM_TRAY: {
    validation: schema.number(),
    default: 3000,
  },

  APP_MAINTENANCE: {
    validation: schema.boolean(),
    default: false,
  },

  APP_MAINTENANCE_SECRET: {
    validation: schema.string(),
    default: '',
  },

  APP_COMING_SOON: {
    validation: schema.boolean(),
    default: false,
  },

  APP_COMING_SOON_SECRET: {
    validation: schema.string(),
    default: '',
  },

  DEBUG: {
    validation: schema.boolean(),
    default: false,
  },

  API_PREFIX: {
    validation: schema.string(),
    default: '/api',
  },

  DOCS_PREFIX: {
    validation: schema.string(),
    default: '/docs',
  },

  DB_CONNECTION: {
    validation: schema.enum(['mysql', 'sqlite', 'postgres']),
    default: 'postgres',
  },

  DB_HOST: {
    validation: schema.string(),
    default: 'localhost',
  },

  DB_PORT: {
    validation: schema.number(),
    default: 5432,
  },

  AWS_ACCOUNT_ID: {
    validation: schema.string(),
    default: '',
  },

  AWS_ACCESS_KEY_ID: {
    validation: schema.string(),
    default: '',
  },

  AWS_SECRET_ACCESS_KEY: {
    validation: schema.string(),
    default: '',
  },

  AWS_DEFAULT_REGION: {
    validation: schema.string(),
    default: '',
  },

  AWS_DEFAULT_PASSWORD: {
    validation: schema.string(),
    default: '',
  },

  MAIL_MAILER: {
    validation: schema.enum(['ses', 'sendgrid', 'mailgun', 'mailtrap', 'smtp', 'postmark', 'sendmail', 'log']),
    default: 'ses',
  },

  MAIL_HOST: {
    validation: schema.string(),
    default: '',
  },

  MAIL_PORT: {
    validation: schema.number(),
    default: 465,
  },

  MAIL_USERNAME: {
    validation: schema.string(),
    default: '',
  },

  MAIL_PASSWORD: {
    validation: schema.string(),
    default: '',
  },

  MAIL_FROM_ADDRESS: {
    validation: schema.string(),
    default: '',
  },

  SEARCH_ENGINE_DRIVER: {
    validation: schema.enum(['meilisearch', 'algolia', 'typesense']),
    default: 'meilisearch',
  },

  STRIPE_SECRET_KEY: {
    validation: schema.string(),
    default: '',
  },

  STRIPE_PUBLISHABLE_KEY: {
    validation: schema.string(),
    default: '',
  },

  // Read by config/services.ts and verified against every incoming webhook in
  // app/Actions/StripeWebhook.ts, which returns 400 when it is unset. It was
  // consumed there without ever being declared here, so a fresh clone had no
  // way to learn the variable exists — and an unset secret does not fail
  // loudly at boot, it fails silently at the moment a real payment arrives and
  // the subscription never syncs.
  STRIPE_WEBHOOK_SECRET: {
    validation: schema.string(),
    default: '',
  },

  MEILISEARCH_HOST: {
    validation: schema.string(),
    default: '',
  },

  MEILISEARCH_KEY: {
    validation: schema.string(),
    default: '',
  },

  FRONTEND_APP_ENV: {
    validation: schema.enum(['development', 'staging', 'production']),
    default: 'development',
  },

  FRONTEND_APP_URL: {
    validation: schema.string(),
    default: '',
  },
} satisfies EnvConfig
