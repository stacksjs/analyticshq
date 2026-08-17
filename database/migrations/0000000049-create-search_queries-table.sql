-- Search Console import (#25).
--
-- NOTE ON STYLE: no semicolons in comments below the first statement, and no
-- comment block after the last statement. See migration 48 for the measured
-- rule and why migration 47 states a stricter one.
--
-- WHAT THIS HOLDS, AND WHY IT IS NOT VISITOR DATA
--
-- Rows describe SEARCHES, not visits. Google reports, per day, that a query was
-- shown N times and clicked M times for a given page. There is no visitor
-- dimension in the API and none here: nothing in this table can be attributed
-- to a person, joined to a visitor hash, or narrowed to an individual.
--
-- Google withholds queries made by too few people before we ever see them --
-- the "anonymized queries" it reports as a bulk total rather than by name -- so
-- the low-volume tail that could identify someone never reaches this table.
-- That filtering is Google's, applied at their end, and it is the reason an SEO
-- import does not need the disclosure floor the segment and vitals reports
-- carry.
--
-- The consequence worth writing down: this table is deliberately NOT in the
-- GDPR erasure list in routes/analytics.ts. "Delete everything about this
-- visitor" cannot reach rows that were never about a visitor, and adding it
-- there would mean inventing a visitor_id to erase by -- manufacturing exactly
-- the linkage the schema is shaped to avoid.
--
-- NO ctr COLUMN
--
-- Click-through rate is clicks divided by impressions. Google sends it, and
-- storing it means two sources for one number that agree until a partial import
-- or a rounding change makes them disagree, with no way to tell which is right.
-- It is computed at read time from the two counts that are stored.
--
-- position IS double precision
--
-- Average position is fractional (3.7, not 4), and it is an average of ranks
-- weighted by impressions. An integer column would round every SEO report to
-- whole positions and lose the movement that is the entire point of tracking it
-- -- the same mistake the vitals table avoided for CLS in migration 47.
--
-- THE PRIMARY KEY IS DETERMINISTIC
--
-- id is a hash of site + date + query + page, so re-importing an overlapping
-- range updates rows rather than doubling them. Search Console revises recent
-- days for about three days after the fact, so re-importing the last week is a
-- normal thing to do and must converge on Google's current numbers rather than
-- accumulate every revision.
CREATE TABLE IF NOT EXISTS "search_queries" (
  "id" varchar(64) PRIMARY KEY,
  "site_id" varchar(64) NOT NULL,
  -- YYYY-MM-DD. Day granularity is all Search Console reports.
  "date" varchar(10) NOT NULL,
  -- The search term. Google caps these well under the column width.
  "query" varchar(255) NOT NULL,
  -- The page that ranked, stored as a path so it matches page_views.path.
  "path" varchar(255) NOT NULL,
  "clicks" integer NOT NULL,
  "impressions" integer NOT NULL,
  -- Average position, fractional. See the note above.
  "position" double precision NOT NULL
);
-- Deleting a site takes its search data with it, like every other table.
ALTER TABLE "search_queries" DROP CONSTRAINT IF EXISTS "search_queries_site_id_fk";
ALTER TABLE "search_queries" DROP CONSTRAINT IF EXISTS "search_queries_site_id_fk";
ALTER TABLE "search_queries" DROP CONSTRAINT IF EXISTS "search_queries_site_id_fkey";
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;
-- Every read is one site over a date range, then grouped by query or by page.
CREATE INDEX IF NOT EXISTS "sq_site_date" ON "search_queries" ("site_id", "date");
CREATE INDEX IF NOT EXISTS "sq_site_path" ON "search_queries" ("site_id", "path");
