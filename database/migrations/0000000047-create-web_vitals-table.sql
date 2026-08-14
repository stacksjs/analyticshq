-- Core Web Vitals (#41).
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on ";" without first stripping "--" lines, so a semicolon inside a
-- comment ends the statement early and the rest of the sentence runs as SQL.
--
-- WHY A TABLE RATHER THAN custom_events
--
-- custom_events already has a nullable numeric `value`, so a vital could be
-- stored as an event named "LCP". It should not be. Events are a user-defined
-- namespace -- a site owner can call an event anything, including "LCP" -- so the
-- vitals reports would be reading a namespace someone else is free to write into,
-- and a site that fires its own "CLS" event would corrupt its own speed report
-- with no way for either side to detect it.
--
-- The two also have opposite retention pressure. Vitals are written on every page
-- view and are only ever read as an aggregate percentile, so they are the first
-- thing an operator would want to prune aggressively. Mixed into the events table
-- that is not expressible.
--
-- NO SESSION ID
--
-- page_views and custom_events both carry session_id. This does not, because
-- nothing here is a funnel or a journey -- every read is "the 75th percentile of
-- this metric for this site over this window", optionally by path. Storing a
-- session key that no query groups by would be collecting a linkage we have no
-- use for, and the whole product argument is that we do not do that.
--
-- visitor_id IS here, and only for erasure: it is what lets the GDPR endpoint in
-- routes/analytics.ts reach these rows alongside the other four tables. It is the
-- same 24h-rotating per-site hash as everywhere else, so it adds no durable
-- identifier -- but leaving it out would have made this the one table a visitor
-- could not be erased from.
--
-- value IS double precision, NOT the integer trick
--
-- The ts-analytics tracker rounds every metric to an integer, which floors CLS
-- (a unitless ratio, typically 0.05-0.25) to 0 -- so it multiplies CLS by 1000 on
-- the wire and divides it back at read time, in two separate places. That is a
-- bug waiting to be reintroduced by the third reader, and it already was one
-- (ts-analytics#133). A float column takes the real value and no reader needs to
-- know which metric is special.
CREATE TABLE IF NOT EXISTS "web_vitals" (
  "id" varchar(64) PRIMARY KEY,
  "site_id" varchar(64) NOT NULL,
  -- Rotating per-site-per-day hash, as on page_views. Present for erasure.
  "visitor_id" varchar(64) NOT NULL,
  -- The path the measurement was taken on, so a slow page is attributable to a
  -- page. Same varchar(255) cap as page_views.path.
  "path" varchar(255) NOT NULL,
  -- One of LCP, CLS, INP, FCP, TTFB. Deliberately NOT FID, which Google retired
  -- in favour of INP in March 2024 -- ts-analytics still collects it.
  "metric" varchar(8) NOT NULL,
  -- Milliseconds for every metric except CLS, which is a unitless ratio.
  "value" double precision NOT NULL,
  "timestamp" varchar(32) NOT NULL
);
-- Deleting a site takes its vitals with it, like every other analytics table.
ALTER TABLE "web_vitals" DROP CONSTRAINT IF EXISTS "web_vitals_site_id_fk";
ALTER TABLE "web_vitals" DROP CONSTRAINT IF EXISTS "web_vitals_site_id_fk";
ALTER TABLE "web_vitals" DROP CONSTRAINT IF EXISTS "web_vitals_site_id_fkey";
ALTER TABLE "web_vitals" ADD CONSTRAINT "web_vitals_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;
-- The shape of every read: one metric, one site, one window. Ordering by metric
-- before timestamp because the metric is always an equality and the timestamp is
-- always a range.
CREATE INDEX IF NOT EXISTS "wv_site_metric_timestamp" ON "web_vitals" ("site_id", "metric", "timestamp");
-- The per-path breakdown groups on path within an already-narrowed window.
CREATE INDEX IF NOT EXISTS "wv_site_path" ON "web_vitals" ("site_id", "path");
-- Erasure looks rows up by visitor and nothing else does.
CREATE INDEX IF NOT EXISTS "wv_visitor" ON "web_vitals" ("visitor_id");
