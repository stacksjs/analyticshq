import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One Core Web Vitals measurement (#41, migrations 0000000047 and 0000000048).
 *
 * The table predates this model: it was written only by raw SQL in /collect,
 * so nothing could create a row through the ORM. Declared column for column
 * against the migrations, because the schema differ drops any column a model
 * does not name (tests/unit/model-columns.test.ts).
 *
 * No session_id and no timestamps columns, by design: see migration 47 for why
 * a vitals row carries no linkage to a visit.
 */
export default defineModel({
  name: 'WebVital',
  table: 'web_vitals',
  primaryKey: 'id',

  traits: {
    useTimestamps: false,
  },

  belongsTo: ['Site'],

  indexes: [
    { name: 'wv_site_metric_timestamp', columns: ['site_id', 'metric', 'timestamp'] },
    { name: 'wv_site_path', columns: ['site_id', 'path'] },
    { name: 'wv_visitor', columns: ['visitor_id'] },
  ],

  attributes: {
    id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    site_id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    // The rotating per-site visitor hash, present only so erasure reaches these rows.
    visitor_id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    path: { fillable: true, validation: { rule: schema.string().required().max(255) } },
    // LCP, CLS, INP, FCP or TTFB.
    metric: { fillable: true, validation: { rule: schema.string().required().max(8) } },
    // Milliseconds, except CLS, which is a unitless ratio.
    value: { fillable: true, type: 'double', validation: { rule: schema.number().required() } },
    timestamp: { fillable: true, validation: { rule: schema.string().required().max(32) } },
    // Nullable: measurements from before migration 48 have no device.
    device_type: { fillable: true, validation: { rule: schema.string().optional().max(16) } },
  },
})
