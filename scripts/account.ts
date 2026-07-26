/**
 * Account and credential management for a deployed analyticshq.
 *
 *   bun scripts/account.ts --list
 *   bun scripts/account.ts --create --email=you@example.com --name="Your Name"
 *   bun scripts/account.ts --rotate --email=you@example.com
 *   bun scripts/account.ts --rotate --email=you@example.com --password='...'
 *   bun scripts/account.ts --attach --site=zig-utils --email=you@example.com
 *   bun scripts/account.ts --revoke-tokens --email=you@example.com
 *
 * Run it on the box (or with `DB_*` pointed at it) — it talks to Postgres
 * directly, like the other scripts here, because the framework's database
 * client hangs outside a full app boot.
 *
 * Passwords are hashed with bcrypt at cost 12, matching what the framework's
 * `register` writes, so a rotated password works with the normal login flow.
 * The cost is read back from the existing hash where there is one rather than
 * assumed, so this cannot silently downgrade a stronger setting.
 *
 * A generated password is printed ONCE, to stdout, and never stored anywhere
 * else. Rotating always revokes existing tokens: leaving them live would mean
 * a rotation does not actually lock anyone out.
 */
import { connect, log, parseArgs, requireArg } from './analytics/lib'

const DEFAULT_BCRYPT_COST = 12

const args = parseArgs()
const sql = connect()

/** A readable, high-entropy password: 4 groups of 5 url-safe chars. */
function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const raw = btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, '')
  return (raw.slice(0, 20).match(/.{1,5}/g) ?? []).join('-')
}

/** Reuse the cost already in use, so a rotation never weakens the hash. */
function costOf(existingHash: string | undefined): number {
  const m = existingHash?.match(/^\$2[aby]\$(\d{2})\$/)
  return m ? Number(m[1]) : DEFAULT_BCRYPT_COST
}

async function findUser(email: string): Promise<{ id: number, email: string, name: string, password: string } | undefined> {
  const rows = await sql`SELECT id, email, name, password FROM users WHERE email = ${email} LIMIT 1`
  return rows[0]
}

/** Invalidate every credential a stolen password could still be riding. */
async function revokeTokens(userId: number): Promise<number> {
  // Refresh tokens FIRST: they are found through the access tokens
  // (`access_token_id`), so deleting the access rows first would leave every
  // refresh token orphaned and live — a rotation that does not lock anyone out.
  const refresh = await sql`DELETE FROM oauth_refresh_tokens WHERE access_token_id IN (
    SELECT id FROM oauth_access_tokens WHERE user_id = ${userId}
  ) RETURNING id`
  const access = await sql`DELETE FROM oauth_access_tokens WHERE user_id = ${userId} RETURNING id`
  return refresh.length + access.length
}

if (args.list) {
  const users = await sql`SELECT id, email, name, password_changed_at FROM users ORDER BY id`
  if (users.length === 0)
    log('no users')
  for (const u of users) {
    const sites = await sql`SELECT id FROM sites WHERE owner_id = ${u.id} ORDER BY id`
    log(`#${u.id}  ${u.email}  (${u.name})  sites: ${sites.map((s: any) => s.id).join(', ') || '—'}`)
  }
  const orphans = await sql`SELECT id FROM sites WHERE owner_id IS NULL ORDER BY id`
  if (orphans.length > 0)
    log(`unowned sites (invisible in the dashboard): ${orphans.map((s: any) => s.id).join(', ')}`)
}

else if (args.create) {
  const email = requireArg(args, 'email')
  const name = requireArg(args, 'name')
  if (await findUser(email)) {
    log(`error: ${email} already exists — use --rotate to change its password`)
    process.exit(1)
  }
  const password = typeof args.password === 'string' ? args.password : generatePassword()
  const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: DEFAULT_BCRYPT_COST })
  const now = new Date().toISOString()
  const [user] = await sql`
    INSERT INTO users (name, email, password, created_at, password_changed_at)
    VALUES (${name}, ${email}, ${hash}, ${now}, ${now})
    RETURNING id`
  log(`created user #${user.id} ${email}`)
  if (typeof args.password !== 'string')
    process.stdout.write(`${password}\n`)
}

else if (args.rotate) {
  const email = requireArg(args, 'email')
  const user = await findUser(email)
  if (!user) {
    log(`error: no user with email ${email}`)
    process.exit(1)
  }
  const password = typeof args.password === 'string' ? args.password : generatePassword()
  const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: costOf(user.password) })
  await sql`UPDATE users SET password = ${hash}, password_changed_at = ${new Date().toISOString()} WHERE id = ${user.id}`
  const revoked = await revokeTokens(user.id)
  log(`rotated password for #${user.id} ${email}; revoked ${revoked} token(s)`)
  if (typeof args.password !== 'string')
    process.stdout.write(`${password}\n`)
}

else if (args.attach) {
  const site = requireArg(args, 'site')
  const email = requireArg(args, 'email')
  const user = await findUser(email)
  if (!user) {
    log(`error: no user with email ${email}`)
    process.exit(1)
  }
  const updated = await sql`UPDATE sites SET owner_id = ${user.id} WHERE id = ${site} RETURNING id`
  if (updated.length === 0) {
    log(`error: no site with id ${site}`)
    process.exit(1)
  }
  log(`site ${site} now owned by #${user.id} ${email}`)
}

else if (args['revoke-tokens']) {
  const email = requireArg(args, 'email')
  const user = await findUser(email)
  if (!user) {
    log(`error: no user with email ${email}`)
    process.exit(1)
  }
  log(`revoked ${await revokeTokens(user.id)} token(s) for ${email}`)
}

else {
  log(`usage:
  --list                                    users, their sites, and any unowned sites
  --create --email= --name= [--password=]   create a user (password generated if omitted)
  --rotate --email= [--password=]           set a new password and revoke live tokens
  --attach --site= --email=                 make a user the owner of a site
  --revoke-tokens --email=                  sign a user out everywhere`)
  process.exit(1)
}

await sql.end()
