-- Restore columns the schema differ dropped from production.
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on ";" without first stripping "--" lines.
--
-- WHAT HAPPENED
--
-- Migrations 0000000045 (revenue) and 0000000046 (custom domains) added these
-- columns with raw SQL, but the models never declared them. `buddy migrate`
-- runs a differ that compares the live tables against the models and drops any
-- column the models do not name, so a later deploy removed all seven. Every
-- query naming one then failed: GET /api/sites selects sites.currency and
-- answered 500 for every signed-in user, which is how this was found.
--
-- The models now declare them (app/Models/Site.ts, Goal.ts, Conversion.ts) at
-- the same types, and tests/unit/model-columns.test.ts fails CI if a migration
-- adds a column its model does not name. This file puts the columns back on
-- an install that already lost them. Every statement is idempotent, so on an
-- install that never lost them it changes nothing. The data they held is gone
-- and is not recoverable from here.
ALTER TABLE "conversions" ADD COLUMN IF NOT EXISTS "amount_minor" bigint;
ALTER TABLE "conversions" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "default_amount_minor" bigint;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "custom_domain" varchar(255);
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "custom_domain_verified_at" varchar(32);
CREATE INDEX IF NOT EXISTS "conversions_revenue" ON "conversions" ("site_id", "timestamp", "currency");
CREATE UNIQUE INDEX IF NOT EXISTS "sites_custom_domain" ON "sites" ("custom_domain") WHERE "custom_domain" IS NOT NULL;
