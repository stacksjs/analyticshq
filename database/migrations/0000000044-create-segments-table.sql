-- Saved segments (#23).
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on ";" without first stripping "--" lines, so a semicolon inside a
-- comment ends the statement early and the rest of the sentence runs as SQL.
--
-- A segment is a named filter combination -- "mobile visitors from search",
-- "everything under /docs" -- saved so it can be reapplied without rebuilding it
-- by clicking. Nothing here is a new way to query: `filters` holds exactly the
-- key/value bag the Stats API already reads from the query string, so applying a
-- segment is a merge rather than a translation. A second code path that turned
-- segments into SQL independently would be free to disagree with the live
-- filters, and disagreements between two spellings of the same question are very
-- hard to notice from the outside.
--
-- PER SITE, NOT PER USER
--
-- The issue proposed "per user/site". This is per site. A segment is a way of
-- reading the site, and every member looking at that site benefits from the ones
-- their colleagues built -- an agency where each analyst rebuilds "checkout
-- traffic" from scratch is the situation saved segments exist to remove. It also
-- keeps deletion simple: segments die with the site, and there is no orphaned
-- per-user state to reap when a member is removed.
--
-- Making them private per user is a later, additive change (a nullable owner
-- column and a filter on read). Starting shared and adding privacy is reversible.
-- Starting private and making them shared is not, because it changes who can see
-- something people have already saved.
CREATE TABLE IF NOT EXISTS "segments" (
  "id" varchar(64) PRIMARY KEY,
  "site_id" varchar(64) NOT NULL,
  "name" varchar(128) NOT NULL,
  -- JSON object of filter params, e.g. {"device":"Mobile","path__matches":"^/blog/"}
  "filters" text NOT NULL,
  "created_at" varchar(32) NOT NULL,
  "updated_at" varchar(32)
);
-- Deleting a site takes its segments with it, like alerts, funnels and members.
ALTER TABLE "segments" DROP CONSTRAINT IF EXISTS "segments_site_id_fk";
ALTER TABLE "segments" DROP CONSTRAINT IF EXISTS "segments_site_id_fkey";
ALTER TABLE "segments" DROP CONSTRAINT IF EXISTS "segments_site_id_fk";
ALTER TABLE "segments" ADD CONSTRAINT "segments_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;
-- Segments are listed per site and never globally.
CREATE INDEX IF NOT EXISTS "segments_site" ON "segments" ("site_id");
