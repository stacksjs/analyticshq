-- Drop the fingerprint-adjacent columns from page_views (#10).
--
-- DESTRUCTIVE AND INTENTIONALLY SO. This deletes already-collected data, which is
-- the point: the columns were written on every page view and read by nothing, so
-- retaining them is pure liability with no reporting cost to removing them.
--
--   title          — a page title routinely carries page content, and on a real
--                    app that means personal data ("Invoice #4432 — Jane Smith",
--                    "Reset password for alice@example.com"). We stored it in a
--                    varchar(255) indefinitely while claiming, on our own
--                    comparison pages, to hold no personal data.
--   screen_width   — passive fingerprinting vector. device_type is derived from
--   screen_height    the User-Agent (routes/analytics.ts, info.deviceType), not
--                    from these, so no report loses anything.
--
-- Verified write-only before removal: every SELECT in routes/analytics.ts is
-- column-explicit, there is no `SELECT *` anywhere in routes/ or app/, and none
-- of the three appears in any read path.
--
-- If page titles are ever wanted for a report, they should return as a per-site
-- opt-in, never as a default.
ALTER TABLE "page_views" DROP COLUMN IF EXISTS "title";
ALTER TABLE "page_views" DROP COLUMN IF EXISTS "screen_width";
ALTER TABLE "page_views" DROP COLUMN IF EXISTS "screen_height";
