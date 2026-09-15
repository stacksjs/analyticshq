-- Opt-in region (state/province) geolocation.
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on ";" without first stripping "--" lines, so a semicolon inside a
-- comment ends the statement early and the rest of the sentence runs as SQL.
--
-- WHAT THIS REVERSES, AND WHAT IT DOES NOT
--
-- Migration 0000000011 dropped "region" and "city" from both tables to remove
-- the latent capability from the schema, because country-only geolocation was
-- an unconditional invariant (issue #7). This brings back exactly one of those
-- two columns, and only as something a site owner switches on.
--
-- "city" is NOT coming back. tests/unit/privacy-guardrails.test.ts still fails
-- CI if a city column appears in the schema or the models, app/Analytics/geo.ts
-- reads subdivisions[0] and has no code path that reaches a city name, and the
-- comparison pages still say no city, ever. Region is a state or a province.
-- That is the whole of the loosening.
--
-- WHY A COLUMN ON sites RATHER THAN A CONFIG FLAG
--
-- config/privacy.ts sets what this INSTALL permits and the site column sets what
-- this SITE asked for, and both have to say yes. An operator running analyticshq
-- for other people can hold the whole instance at country with one env var,
-- which a per-site setting alone could not express. The instance default stays
-- country, so an existing deployment that pulls this migration changes nothing
-- about what it records.
--
-- WHY IT DEFAULTS TO FALSE AND IS NOT NULLABLE
--
-- A NULL here would mean "not decided", and there is no such state -- a site is
-- either recording sub-country location or it is not. Every site that exists
-- when this runs gets false, which is what they were already doing, so the
-- migration cannot change the behaviour of a single site on its own.
--
-- WHY varchar(6)
--
-- Values are ISO 3166-2 written as country-subdivision, "US-CA" or "GB-ENG".
-- Two for the country, one separator, and ISO subdivision codes are one to
-- three characters. The compound form is deliberate -- a bare "CA" is
-- California here and Canada in the country column, so an unprefixed
-- subdivision would collide with country codes in any query touching both.
ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "region" varchar(6);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "region" varchar(6);
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "region_geo" boolean NOT NULL DEFAULT false;

-- Partial, so the index costs nothing on the sites that never opt in -- which,
-- on the day this ships, is all of them.
CREATE INDEX IF NOT EXISTS "page_views_pv_site_region" ON "page_views" ("site_id", "region") WHERE "region" IS NOT NULL;
