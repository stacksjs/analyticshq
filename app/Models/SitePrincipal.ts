import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A site's machine identity: the owner of the tokens that act for the
 * site rather than for a person.
 *
 * Stacks personal access tokens are polymorphic. Each records its owner's
 * table and that owner's numeric id (`tokenable_type`, `tokenable_id`), so any
 * model can hold tokens, not only `User`. A site's id here is text, which that
 * pair cannot carry, so a site is given one row in this table and the row's id
 * is what its tokens belong to.
 *
 * That is all this is: a numeric handle for a site, one to one. A read key is a
 * token owned by it (app/Support/site-tokens.ts).
 * Because no person owns them, they are unaffected by anybody's password
 * change or by the site changing hands, and the framework will not resolve
 * one to a user, so it can never be a session.
 *
 * No `useApi` and no fillable fields: rows are created on demand by
 * `principalId`, never by a request.
 */
export default defineModel({
  name: 'SitePrincipal',
  table: 'site_principals',

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['Site'],

  indexes: [
    { name: 'site_principals_site_unique', columns: ['site_id'], unique: true },
  ],

  attributes: {
    site_id: { fillable: false, validation: { rule: schema.string().required().max(255) } },
  },
})
