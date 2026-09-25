-- Opt-in visitor timelines: how many days one visitor keeps the same id.
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on semicolons without first stripping comment lines.
--
-- WHAT IT DOES
--
-- The visitor id is a hash of the IP, the browser and a secret salt. The salt
-- used to change every UTC day, so nobody, including the site owner, could tie
-- a visitor to themselves on another day. A site whose owner turns on visitor
-- timelines keeps one salt for a fixed block of this many days instead, so the
-- dashboard can show that visitor's visits across the block. When the block
-- ends its salt is deleted and the ids from it can never be linked again. See
-- app/Analytics/salt.ts.
--
-- WHY IT DEFAULTS TO 1 AND IS NOT NULLABLE
--
-- 1 is exactly the old behaviour, so this migration changes nothing for any
-- site. Only the site owner can lengthen it, and config/privacy.ts caps it at
-- maxVisitorWindowDays (30). The CHECK keeps a hand-written UPDATE inside that
-- range as well.
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "visitor_window_days" integer NOT NULL DEFAULT 1;
ALTER TABLE "sites" DROP CONSTRAINT IF EXISTS "sites_visitor_window_days_range";
ALTER TABLE "sites" ADD CONSTRAINT "sites_visitor_window_days_range" CHECK ("visitor_window_days" BETWEEN 1 AND 30);

-- The daily purge reads each salt's site. Nothing about the salts table changes.
CREATE INDEX IF NOT EXISTS "visitor_salts_salt_date" ON "visitor_salts" ("salt_date");
