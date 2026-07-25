import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'Conversion',
  table: 'conversions',
  primaryKey: 'id',

  // Append-heavy fact table; the (site_id, timestamp) index below is what
  // bounds the time-scoped per-site scans the dashboard runs.

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['Site', 'Goal'],

  indexes: [
    { name: 'conv_site_goal_timestamp', columns: ['site_id', 'goal_id', 'timestamp'] },
  ],

  attributes: {
    id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    site_id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    goal_id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    visitor_id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    session_id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    value: { fillable: true, validation: { rule: schema.number().optional() } },
    path: { fillable: true, validation: { rule: schema.string().optional() } },
    referrer_source: { fillable: true, validation: { rule: schema.string().optional().max(128) } },
    utm_source: { fillable: true, validation: { rule: schema.string().optional().max(128) } },
    utm_campaign: { fillable: true, validation: { rule: schema.string().optional().max(128) } },
    timestamp: { fillable: true, validation: { rule: schema.string().required().max(32) } },
  },
})
