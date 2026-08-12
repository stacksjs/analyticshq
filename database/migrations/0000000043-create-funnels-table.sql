-- Multi-step funnels, aggregate only (#21).
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on ";" without first stripping "--" lines, so a semicolon inside a
-- comment ends the statement early and the rest of the sentence runs as SQL.
--
-- WHAT A FUNNEL CAN AND CANNOT SEE HERE
--
-- A funnel asks whether the same person reached step 2 after step 1, so it needs
-- an identity that survives between the steps. This product has two, and neither
-- lasts long:
--
--   session_id  one visit
--   visitor_id  sha256(ip | ua | site | secret salt) where the salt is random,
--               per site, per UTC day, and DELETED at the end of retention
--
-- The consequence is worth stating plainly, because it is a property rather than
-- a policy: a funnel spanning more than one day is not something we decline to
-- compute, it is something nobody can compute from this data, including us. Once
-- a day's salt is gone its hashes are unlinkable to any input forever. So a
-- visitor who lands at 23:50 and converts at 00:10 counts as two different
-- people, and a 30-day funnel is the sum of 30 one-day funnels rather than a
-- 30-day journey.
--
-- `scope` picks which identity is used:
--
--   session  all steps within one visit -- the strict reading, right for checkout
--   day      steps within one UTC day, across visits from the same visitor hash
--
-- STEPS
--
-- A JSON array of goal ids, in order. Goals rather than raw paths on purpose:
-- /collect already matches goals on the hot path and writes a conversion row, so
-- reusing them means the funnel and the goal report can never disagree about
-- whether something happened. A parallel path-matching engine here would be a
-- second opinion, and second opinions drift.
--
-- Only the ids are stored. Step labels are read from the goals table when the
-- funnel is rendered, so renaming a goal renames it everywhere at once.
CREATE TABLE IF NOT EXISTS "funnels" (
  "id" varchar(64) PRIMARY KEY,
  "site_id" varchar(64) NOT NULL,
  "name" varchar(128) NOT NULL,
  -- JSON array of goal ids, ordered, 2 to 8 entries, no repeats.
  "steps" text NOT NULL,
  -- 'session' | 'day'
  "scope" varchar(16) NOT NULL DEFAULT 'session',
  "created_at" varchar(32) NOT NULL,
  "updated_at" varchar(32)
);
-- Deleting a site takes its funnels with it, like alerts and memberships.
ALTER TABLE "funnels" DROP CONSTRAINT IF EXISTS "funnels_site_id_fk";
ALTER TABLE "funnels" DROP CONSTRAINT IF EXISTS "funnels_site_id_fkey";
ALTER TABLE "funnels" DROP CONSTRAINT IF EXISTS "funnels_site_id_fk";
ALTER TABLE "funnels" ADD CONSTRAINT "funnels_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;
-- Funnels are listed per site and never globally.
CREATE INDEX IF NOT EXISTS "funnels_site" ON "funnels" ("site_id");
