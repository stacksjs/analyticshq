import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'Site',
  table: 'sites',
  primaryKey: 'id',


  traits: {
    useTimestamps: true,
    // NO useApi. It generated the same five paths routes/analytics.ts serves by
    // hand — and `PATCH /api/sites/{id}` WON, shadowing the guarded route and
    // breaking site updates outright for everyone including the owner.
    //
    // It failed with 400 "Invalid ID parameter" rather than doing damage, only
    // because the generated handler coerces the id to a number and site ids here
    // are strings. That is luck, not safety: the same collision on a model with
    // numeric ids would have reached a handler that applies no row scoping,
    // because Site declares neither `ownership` nor a `team_id`.
    //
    // Every route this model needs already exists in routes/analytics.ts behind
    // requireSiteRole. Generating a second, unguarded set of the same paths
    // could only ever take precedence over the guarded one or be redundant.
  },

  hasMany: ['Session', 'PageView', 'CustomEvent', 'Goal'],

  attributes: {
    id: {
      fillable: true,
      validation: { rule: schema.string().required() },
    },

    name: {
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
    },

    domains: {
      fillable: true,
      validation: { rule: schema.string().optional() },
      factory: () => '[]',
    },

    timezone: {
      fillable: true,
      validation: { rule: schema.string().optional() },
      factory: () => 'UTC',
    },

    is_active: {
      fillable: true,
      validation: { rule: schema.boolean().optional() },
      factory: () => true,
    },

    owner_id: {
      fillable: true,
      validation: { rule: schema.number().optional() },
    },

    settings: {
      fillable: true,
      validation: { rule: schema.string().optional() },
      factory: () => '{}',
    },
  },
})
