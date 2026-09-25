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

    // Default currency for revenue events that name none (#22, migration
    // 0000000045). Missing from this model, so the schema differ dropped it in
    // production and GET /api/sites, which selects it, answered 500.
    currency: {
      fillable: true,
      validation: { rule: schema.string().optional().max(3) },
    },

    // Custom tracking domain (migration 0000000046). Missing for the same
    // reason and dropped the same way.
    custom_domain: {
      fillable: true,
      validation: { rule: schema.string().optional().max(255) },
    },

    custom_domain_verified_at: {
      fillable: true,
      validation: { rule: schema.string().optional().max(32) },
    },

    // Region (state/province) geolocation, off unless the site owner turns it on
    // and the install permits it (config/privacy.ts). Declared here because the
    // schema differ compares the live tables against these attributes, and a
    // column the models do not name is one it proposes dropping on every deploy
    // -- which is what refused three deploys in a row on 2026-08-23.
    region_geo: {
      fillable: true,
      validation: { rule: schema.boolean().optional() },
      factory: () => false,
    },

    // City geolocation, the same terms one level finer: off unless the site owner
    // turns it on and the install's geo.granularity reaches 'city'.
    city_geo: {
      fillable: true,
      validation: { rule: schema.boolean().optional() },
      factory: () => false,
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
