-- Platform admins: accounts that see and manage every site on the install.
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on semicolons without first stripping comment lines.
--
-- WHY A COLUMN AND NOT AN EMAIL CHECK
--
-- Registration does not verify addresses. A rule like "cloud@stacksjs.com is an
-- admin" evaluated at request time hands the install to whoever registers that
-- address first, and to anyone who can later change their address to it. A flag
-- on the row is granted once, to the account that holds the address when this
-- runs, and nothing a user can send changes it. app/Models/User.ts declares it
-- guarded and not fillable, and scripts/account.ts --grant-admin is the only
-- other writer.
--
-- WHAT AN ADMIN GETS
--
-- admin rank on every site (reports, settings, goals, members, sharing) and the
-- whole site list, unfiltered, in the dashboard switcher and GET /api/sites.
-- Not owner. Deleting a customer's site or its data still takes the customer.
-- See app/Analytics/access.ts.
--
-- Defaults to false and is not nullable, so every existing account keeps exactly
-- the access it had.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_platform_admin" boolean NOT NULL DEFAULT false;

-- The install's operator account. If it does not exist yet, this matches nothing
-- and the grant is done later with scripts/account.ts --grant-admin.
UPDATE "users" SET "is_platform_admin" = true WHERE lower("email") = 'cloud@stacksjs.com';
