import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One day of Search Console data for one query and page (#25, migration
 * 0000000049). Searches, not visits: there is no visitor dimension here.
 *
 * The table predates this model: the Search Console import wrote it by raw
 * SQL. Declared column for column against the migration, because the schema
 * differ drops any column a model does not name.
 */
export default defineModel({
  name: 'SearchQuery',
  table: 'search_queries',
  primaryKey: 'id',

  traits: {
    useTimestamps: false,
  },

  belongsTo: ['Site'],

  indexes: [
    { name: 'sq_site_date', columns: ['site_id', 'date'] },
    { name: 'sq_site_path', columns: ['site_id', 'path'] },
  ],

  attributes: {
    // A hash of site + date + query + page, so re-importing a range converges.
    id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    site_id: { fillable: true, validation: { rule: schema.string().required().max(64) } },
    // YYYY-MM-DD.
    date: { fillable: true, validation: { rule: schema.string().required().max(10) } },
    query: { fillable: true, validation: { rule: schema.string().required().max(255) } },
    path: { fillable: true, validation: { rule: schema.string().required().max(255) } },
    clicks: { fillable: true, type: 'integer', validation: { rule: schema.number().required() } },
    impressions: { fillable: true, type: 'integer', validation: { rule: schema.number().required() } },
    // Average position, fractional (3.7), so not an integer column.
    position: { fillable: true, type: 'double', validation: { rule: schema.number().required() } },
  },
})
