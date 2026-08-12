-- Traffic spike/drop and threshold alerts (#24).
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on ";" without first stripping "--" lines, so a semicolon inside a
-- comment ends the statement early and the rest of the sentence is executed as
-- SQL. See 0000000041 for the failure this caused.
--
-- WHY A TABLE AND NOT settings JSON
--
-- The digest opt-in (#14) is one enum on the site, so it lives in the existing
-- settings JSON and needed no migration. An alert is not one value: a site wants
-- several at once, each with its own metric, threshold, window and delivery
-- channels, and each carries mutable state the job writes back on every run.
-- Rewriting a whole JSON blob to stamp last_fired_at is how two concurrent runs
-- lose one another's writes.
--
-- WHAT last_fired_at IS FOR
--
-- An alert whose condition stays true does not stay newsworthy. Traffic that is
-- up 300 percent at 14:00 is usually still up at 15:00, and firing every hour
-- for the rest of the day teaches the recipient to mute the channel, which is
-- worse than never having alerted. cooldown_minutes suppresses re-firing and
-- last_fired_at is where the clock is kept, on the row rather than in memory, so
-- a redeploy or a second worker does not reset it.
--
-- WHY min_volume EXISTS
--
-- Percentage change on small numbers is noise wearing a suit. Three visitors
-- where there was one is +200 percent and means nothing. min_volume is the floor
-- below which a percentage is not worth believing, and it applies to whichever
-- side of the comparison is at risk of being tiny -- see app/Analytics/alerts.ts,
-- which applies it to the observed count for a spike and to the baseline for a
-- drop.
--
-- CHANNELS
--
-- A JSON array of {type, ...} objects, because a site may want the same alert in
-- email and Slack and one channel's config has no bearing on another's. Nothing
-- reads this column without validating it -- a webhook URL here is a URL this
-- server will POST to, which is an SSRF vector, so it is re-checked at send time
-- and not trusted because it was checked once at write time.
CREATE TABLE IF NOT EXISTS "site_alerts" (
  "id" varchar(64) PRIMARY KEY,
  "site_id" varchar(64) NOT NULL,
  "name" varchar(128) NOT NULL,
  -- 'views' | 'visitors' | 'sessions' | 'conversions'
  "metric" varchar(32) NOT NULL,
  -- Set only when metric is 'conversions'. NULL means every goal on the site.
  "goal_id" varchar(64),
  -- 'spike' | 'drop' compare against a baseline. 'above' | 'below' compare
  -- against a fixed count and ignore the baseline entirely.
  "condition" varchar(16) NOT NULL,
  -- Percent for spike/drop, an absolute count for above/below.
  "threshold" integer NOT NULL,
  -- How much recent time one observation covers.
  "window_minutes" integer NOT NULL DEFAULT 60,
  -- How many prior days supply baseline samples for spike/drop.
  "baseline_days" integer NOT NULL DEFAULT 7,
  "min_volume" integer NOT NULL DEFAULT 20,
  "cooldown_minutes" integer NOT NULL DEFAULT 1440,
  "channels" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "last_fired_at" varchar(32),
  "created_at" varchar(32) NOT NULL,
  "updated_at" varchar(32)
);
-- Deleting a site takes its alerts with it. An orphaned alert row would keep
-- running, keep querying a site id that /collect can re-create as a shadow site,
-- and keep mailing whoever is named in its channels.
ALTER TABLE "site_alerts" DROP CONSTRAINT IF EXISTS "site_alerts_site_id_fk";
ALTER TABLE "site_alerts" DROP CONSTRAINT IF EXISTS "site_alerts_site_id_fkey";
ALTER TABLE "site_alerts" DROP CONSTRAINT IF EXISTS "site_alerts_site_id_fk";
ALTER TABLE "site_alerts" ADD CONSTRAINT "site_alerts_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;
-- The hourly job asks "which alerts are live" and nothing else, so it reads by
-- site and by active flag.
CREATE INDEX IF NOT EXISTS "site_alerts_site" ON "site_alerts" ("site_id");
CREATE INDEX IF NOT EXISTS "site_alerts_active" ON "site_alerts" ("is_active");
