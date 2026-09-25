import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'Goal',
  table: 'goals',
  primaryKey: 'id',


  traits: {
    useTimestamps: true,
    // NO useApi. It generated `/api/goals`, a flat unscoped surface over every
    // goal on every site, next to the real endpoints at
    // `/api/sites/{siteId}/goals` which resolve a per-site role first. A goal
    // carries a customer's conversion names and values, and nothing in this app
    // ever called the generated set.
  },

  belongsTo: ['Site'],
  hasMany: ['Conversion'],

  indexes: [
    { name: 'goals_site', columns: ['site_id'] },
  ],

  attributes: {
    id: { fillable: true, validation: { rule: schema.string().required() } },
    site_id: { fillable: true, validation: { rule: schema.string().required() } },
    name: { fillable: true, validation: { rule: schema.string().required() } },
    type: { fillable: true, validation: { rule: schema.string().required() } },
    pattern: { fillable: true, validation: { rule: schema.string().optional() } },
    match_type: { fillable: true, validation: { rule: schema.string().optional() }, factory: () => 'exact' },
    duration_minutes: { fillable: true, validation: { rule: schema.number().optional() } },
    value: { fillable: true, validation: { rule: schema.number().optional() } },
    // Revenue (#22, migration 0000000045). Declared because the schema differ
    // drops any live column the models do not name: these were missing, so a
    // deploy dropped them from production and every query naming them failed.
    // bigint: minor units can exceed 32 bits, and a max past 2^31 is how the
    // differ is told so.
    default_amount_minor: { fillable: true, validation: { rule: schema.number().optional().max(Number.MAX_SAFE_INTEGER) } },
    currency: { fillable: true, validation: { rule: schema.string().optional().max(3) } },
    is_active: { fillable: true, validation: { rule: schema.boolean().optional() }, factory: () => true },
  },
})
