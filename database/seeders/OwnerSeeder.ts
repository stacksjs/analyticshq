/**
 * The account you sign in with locally, and the production owner bootstrap.
 *
 *   ./buddy seed --only-seeders OwnerSeeder --skip-models
 *
 * ## Why this file has to exist
 *
 * Model-factory seeding will not produce a usable sign-in, in two separate
 * ways. `User` is on @stacksjs/database's ACCOUNT_MODELS list, so the factory
 * pass leaves foreign keys that point at a user null rather than inventing an
 * owner; the framework's note on that list says which account owns a seeded
 * row is "a decision for the app that seeded it (a `demo:account` command, a
 * fixture, a migration), not something a factory should guess". And the
 * `useSeeder` trait on `User` writes rows whose emails come from
 * `faker.internet.email()` -- accounts nobody can sign in to, because the
 * addresses are unknowable. This file is that decision for analyticshq.
 *
 * DemoSiteSeeder beside this one does not cover it and is not meant to: it
 * builds the public demo site deliberately owned by nobody -- "No owner and
 * no members, so it is in nobody's site switcher; the share token in every
 * demo link is the only way in". That is the right shape for a public demo
 * and the wrong shape for signing in, so this adds an owned site instead of
 * touching it. The two are independent; app/Scheduler.ts keeps running
 * DemoSiteSeeder hourly on its own.
 *
 * ## What this app needs that the others do not
 *
 * analyticshq has no teams and no Team model -- app/Actions/Auth/
 * RegisterAction.ts says so: "ownership is `sites.owner_id` + `site_members`".
 * So the seeder makes a user and one site owned by it, which is what the site
 * switcher needs to show anything.
 *
 * No `site_members` row is written for the owner, and that is deliberate
 * rather than an omission. app/Analytics/access.ts resolves access by reading
 * `sites.owner_id` and LEFT JOINing `site_members` for everyone else, so an
 * owner needs no membership row; `site_members` and `site_invites` are the
 * path for invited collaborators. This matches what routes/analytics.ts
 * writes when a site is created through the UI, which is also owner_id only.
 *
 * `mintSiteId` is imported from app/Analytics/sites rather than
 * reimplemented. The id is deliberately unguessable -- a sha256 over owner,
 * name, a uuid and the clock -- because a caller-supplied id "would reopen
 * the land-grab of a live public site-id". A seeded site with a predictable
 * id would quietly undo that property.
 *
 * ## Credentials
 *
 * `ANALYTICSHQ_OWNER_EMAIL` / `ANALYTICSHQ_OWNER_PASSWORD` when set. A local
 * environment falls back to the constants below so that a fresh clone can
 * sign in after one `./buddy seed` with nothing to configure; every other
 * environment must supply the password, and production refuses to run
 * without both. The fallback is keyed on an explicit allowlist of APP_ENV
 * values rather than "not production", so a staging deploy that forgets to
 * set them gets the skip and not a published default password.
 */
import { db, Seeder } from '@stacksjs/database'
import { env } from '@stacksjs/env'
import { log } from '@stacksjs/logging'
import { makeHash, verifyHash } from '@stacksjs/security'
import { mintSiteId } from '../../app/Analytics/sites'

/**
 * The local fallback. `.localhost` is reserved by RFC 6761 and resolves
 * nowhere but this machine, so the address cannot be mistaken for a real
 * mailbox or receive a stray notification.
 */
const DEV_EMAIL = 'owner@analyticshq.localhost'
const DEV_PASSWORD = 'stacks-dev-only'
const DEV_NAME = 'analyticshq Owner'
const SITE_NAME = 'analyticshq'
const SITE_DOMAIN = 'https://analyticshq.localhost'

/**
 * APP_ENV values that may use the fallback credentials above.
 *
 * `dev` and `stage` are in here deliberately: config/env.ts types APP_ENV as
 * the enum local|dev|stage|prod, so `dev` is a value this app really takes
 * even though the committed .env says `development`. Without it the seeder
 * would silently skip on a correctly-configured machine and report success
 * while writing nothing. `stage` is NOT local -- it falls through to the
 * "supply the password" branch below, which is the point of listing the
 * local ones explicitly instead of testing for "not production".
 */
const LOCAL_ENVS = new Set(['development', 'dev', 'local', 'test', 'testing'])
const PRODUCTION_ENVS = new Set(['prod', 'production'])

/**
 * The id of the one user with this address, or undefined.
 *
 * Number(): `users.id` is a bigint and Postgres hands a bigint back as a
 * string. A string flowing into `sites.owner_id` is a foreign key the
 * dialect then rejects, and mintSiteId takes a number. This app reads
 * Postgres, so that is the live path and not a hypothetical -- `sites.id`,
 * by contrast, really is a varchar and is looked up separately below.
 */
async function findUserId(email: string): Promise<number | undefined> {
  const row = await db.selectFrom('users' as any)
    .select(['id'] as any)
    .where('email' as any, '=', email)
    .executeTakeFirst() as { id?: number | string } | undefined

  return row?.id === undefined ? undefined : Number(row.id)
}

/**
 * Whether `password` is the one behind `stored`.
 *
 * verifyHash THROWS rather than returning false when `stored` is not a hash
 * it can parse -- `Password verification failed with error "InvalidEncoding"`
 * -- and a row whose password column holds something unparseable is precisely
 * the case the caller is trying to repair.
 */
async function passwordMatches(password: string, stored: unknown): Promise<boolean> {
  if (typeof stored !== 'string' || stored.length === 0)
    return false

  try {
    return await verifyHash(password, stored)
  }
  catch {
    return false
  }
}

export default class OwnerSeeder extends Seeder {
  static override tags = ['owner'] as const

  async run(): Promise<void> {
    const appEnv = String(env.APP_ENV || '').toLowerCase()
    const isLocal = LOCAL_ENVS.has(appEnv)
    const isProduction = PRODUCTION_ENVS.has(appEnv)

    const envEmail = String(env.ANALYTICSHQ_OWNER_EMAIL || '').trim().toLowerCase()
    const envPassword = String(env.ANALYTICSHQ_OWNER_PASSWORD || '')

    if (isProduction && (!envEmail || !envPassword))
      throw new Error('ANALYTICSHQ_OWNER_EMAIL and ANALYTICSHQ_OWNER_PASSWORD are both required for the production owner bootstrap.')

    if (!envPassword && !isLocal) {
      log.info(`[OwnerSeeder] Skipped: ANALYTICSHQ_OWNER_PASSWORD is not set and APP_ENV="${appEnv}" is not a local environment.`)
      return
    }

    const email = envEmail || DEV_EMAIL
    const password = envPassword || DEV_PASSWORD
    const usedFallback = !envPassword
    const now = new Date().toISOString()

    let userId = await findUserId(email)
    if (!userId) {
      await db.insertInto('users' as any).values({
        name: DEV_NAME,
        email,
        password: await makeHash(password, { algorithm: 'bcrypt' }),
        uuid: crypto.randomUUID(),
        // NOT NULL on this app's users table. This schema has no avatar and
        // no is_super_admin column.
        two_factor_enabled: false,
        // Pre-verified: the local mailbox does not exist, so a seeded account
        // that had to click a link in an email could never finish signing in.
        email_verified_at: now,
        created_at: now,
        updated_at: now,
      } as any).execute()
      userId = await findUserId(email)
    }
    else if (isLocal) {
      /*
       * Keep the documented local password working. Re-running the seeder
       * after changing DEV_PASSWORD, or after an earlier experiment wrote
       * this row with a different hash, would otherwise leave a row that
       * exists and cannot be signed in to -- the exact failure this file is
       * here to end. Checked before writing so a run that changes nothing
       * issues no UPDATE, and confined to local environments so a deploy
       * never silently rotates a real account's password.
       */
      const row = await db.selectFrom('users' as any)
        .select(['password'] as any)
        .where('email' as any, '=', email)
        .executeTakeFirst() as { password?: string } | undefined

      if (!await passwordMatches(password, row?.password)) {
        await db.updateTable('users' as any)
          .set({ password: await makeHash(password, { algorithm: 'bcrypt' }), updated_at: now } as any)
          .where('email' as any, '=', email)
          .execute()
        log.info('[OwnerSeeder] Reset the local owner password to match this seeder.')
      }
    }

    if (!userId)
      throw new Error('The analyticshq owner account could not be resolved after creation.')

    /*
     * One site per owner per name, which is the rule routes/analytics.ts
     * enforces on create (it answers 409 on a clash). Matched on owner_id as
     * well as name so the seeder cannot adopt another account's site of the
     * same name -- and so it can never collide with the demo site, which has
     * no owner at all.
     */
    const site = await db.selectFrom('sites' as any)
      .select(['id'] as any)
      .where('owner_id' as any, '=', userId)
      .where('name' as any, '=', SITE_NAME)
      .executeTakeFirst() as { id?: string } | undefined

    if (!site) {
      await db.insertInto('sites' as any).values({
        // varchar, not an autoincrement integer: server-minted and
        // deliberately unguessable.
        id: mintSiteId(userId, SITE_NAME),
        name: SITE_NAME,
        // Both are stored as JSON text, exactly as the create route writes
        // them; `settings` is read with JSON.parse on the way out.
        domains: JSON.stringify([SITE_DOMAIN]),
        settings: '{}',
        timezone: 'UTC',
        is_active: true,
        owner_id: userId,
        created_at: now,
        updated_at: now,
      } as any).execute()
    }

    log.info(`[OwnerSeeder] Owner site is ready for ${email}.`)
    if (usedFallback)
      log.info(`[OwnerSeeder] Local fallback credentials in use: ${email} / ${DEV_PASSWORD}`)
  }
}

if (import.meta.main)
  await new OwnerSeeder().run()
