/**
 * A site's read key: the credential a machine presents to read that site's
 * analytics.
 *
 * The site id is deliberately public: it ships in the tracking snippet on
 * every page and only permits writes to one site. A read key is the opposite
 * on both counts: it returns data, and it is meant to sit in a server's
 * configuration and nowhere else.
 *
 * It authorises exactly one site. There is no account behind it, so it
 * outlives the person who created it and carries none of their scope, which
 * is the whole reason it exists (#67): a Stacks dashboard reading analytics
 * server-to-server should not be holding somebody's session.
 *
 * A read key is a site token carrying `site:read`
 * (app/Support/site-tokens.ts): a Stacks personal access token owned by the
 * site's principal, hashed at rest, expiring and revocable. This file
 * used to mint, shape-check and compare its own, kept in a column of the
 * sites table in the clear. Nothing here generates, stores or compares a credential now;
 * what is left is the name a key is listed under.
 *
 * A site can hold more than one: `buddy hq:connect` mints one per connect,
 * so a second machine gets its own without the first one's being rotated out
 * from under it, and each can be revoked alone.
 */

/** What a key minted from the settings page is called. */
export const SETTINGS_READ_KEY_NAME = 'Read key'

/** What a key handed to `buddy hq:connect` is called: the app it was connected for. */
export function connectReadKeyName(app: string): string {
  const name = String(app ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
  return name ? `Connected: ${name}` : 'Connected app'
}
