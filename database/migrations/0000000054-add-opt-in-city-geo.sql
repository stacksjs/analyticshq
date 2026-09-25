-- Opt-in city geolocation.
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on ";" without first stripping "--" lines, so a semicolon inside a
-- comment ends the statement early and the rest of the sentence runs as SQL.
--
-- WHAT THIS REVERSES
--
-- Migration 0000000011 dropped "city" along with "region", and 0000000051 brought
-- region back as an opt-in while promising city never would. This brings city
-- back on exactly the same terms as region: a column that stays null unless the
-- install permits it (geo.granularity 'city' in config/privacy.ts), the site
-- owner switches it on (sites.city_geo), and the installed database carries
-- cities (DB-IP City Lite, not Country Lite). Any one of those saying no records
-- nothing.
--
-- City is a NAME and nothing finer. No latitude, no longitude, no postcode.
-- app/Analytics/geo.ts reads city.names.en and never touches the record's
-- location block.
--
-- WHY IT DEFAULTS TO FALSE AND IS NOT NULLABLE
--
-- Same reasoning as region_geo. Every site that exists when this runs gets
-- false, which is what they were already recording, so the migration cannot
-- change the behaviour of a single site on its own. Nothing backfills it.
--
-- WHY varchar(100)
--
-- Values are written as place-colon-name, "US-CA:San Diego" or "SG:Singapore".
-- The place is at most six characters (a region code), one for the colon, and
-- geo.ts caps the name at eighty. The prefix is what makes the value unique
-- across the dozen Springfields a bare name would merge into one row.
ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "city" varchar(100);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "city" varchar(100);
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "city_geo" boolean NOT NULL DEFAULT false;

-- Partial, so the index costs nothing on the sites that never opt in.
CREATE INDEX IF NOT EXISTS "page_views_pv_site_city" ON "page_views" ("site_id", "city") WHERE "city" IS NOT NULL;
