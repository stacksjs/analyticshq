// The application's environment variables, typed from `config/env.ts`.
//
// A Stacks project with a vendored framework gets this from
// `storage/framework/types/env.d.ts`. This app resolves the framework from
// node_modules and has no such tree, so without this file every variable it
// declares (LOGHQ_KEY, STRIPE_WEBHOOK_SECRET, …) was missing from `env` and
// reading one was a type error hidden only by the narrow tsconfig include.
// Same derivation as the framework's file, pointed at this project's schema.

import type { InferEnv } from '@stacksjs/env'

/** The schema `config/env.ts` default-exports. */
type EnvSchema = typeof import('../config/env')['default']

declare module '@stacksjs/env' {
  interface StacksEnv extends InferEnv<EnvSchema> {}
}

export {}
