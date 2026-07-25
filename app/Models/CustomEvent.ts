import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'CustomEvent',
  table: 'custom_events',
  primaryKey: 'id',

  // Append-heavy fact table; the (site_id, timestamp) index below is what
  // bounds the time-scoped per-site scans the dashboard runs.

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['Site', 'Session'],

  // KEYS on the columns event breakdowns filter/group by (event name,
  // visitor), alongside the site/time range and session join.
  indexes: [
    { name: 'ce_site_timestamp', columns: ['site_id', 'timestamp'] },
    { name: 'ce_session', columns: ['session_id'] },
    { name: 'ce_name', columns: ['name'] },
    { name: 'ce_visitor', columns: ['visitor_id'] },
  ],

  attributes: {
    id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    site_id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    session_id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    visitor_id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    name: { fillable: true, validation: { rule: schema.string().required().max(128) } },
    category: { fillable: true, validation: { rule: schema.string().optional().max(64) } },
    value: { fillable: true, validation: { rule: schema.number().optional() } },
    properties: { fillable: true, validation: { rule: schema.string().optional() } },
    path: { fillable: true, validation: { rule: schema.string().optional() } },
    timestamp: { fillable: true, validation: { rule: schema.string().required().max(32) } },
  },
})
