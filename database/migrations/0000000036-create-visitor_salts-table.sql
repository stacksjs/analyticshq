-- Per-site, per-day secret salt for the cookieless visitor hash (#9).
--
-- The salt used to be the plain UTC date, which is public and guessable. That
-- made the visitor hash a CONFIRMATION oracle: anyone holding a digest could
-- test a candidate IP + User-Agent against it and learn whether that person
-- visited the site. Storing no raw IP does not help when the only unknown in
-- sha256(ip|ua|siteId|salt) is the IP itself.
--
-- A random secret closes that. Rows are deleted once past the retention window,
-- and once a day's salt is gone its hashes are permanently unlinkable to any
-- input — which is the property the "rotates every 24 hours" claim on the
-- comparison pages is actually asserting.
CREATE TABLE IF NOT EXISTS "visitor_salts" (
  "site_id" varchar(64) NOT NULL,
  -- UTC calendar day the salt is valid for, as YYYY-MM-DD.
  "salt_date" varchar(10) NOT NULL,
  -- 32 random bytes, hex-encoded.
  "salt" varchar(64) NOT NULL,
  "created_at" varchar(32),
  PRIMARY KEY ("site_id", "salt_date")
);
