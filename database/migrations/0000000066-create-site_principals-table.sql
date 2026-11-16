-- Site principals: the owner of the tokens that act for a site.
--
-- A Stacks personal access token records its owner's table and numeric id
-- (`tokenable_type`, `tokenable_id`). A site's id is text, so each site gets
-- one row here and the row's id is what its read keys belong to
-- (app/Models/SitePrincipal.ts, app/Support/site-tokens.ts).
CREATE TABLE IF NOT EXISTS "site_principals" (
  "id"         SERIAL       PRIMARY KEY,
  "site_id"    varchar(255) NOT NULL REFERENCES "sites" ("id") ON DELETE CASCADE,
  "created_at" timestamptz  NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "site_principals_site_unique" ON "site_principals" ("site_id");

-- A principal for every site that holds a read key, so the key below has an
-- owner. Other sites get theirs the first time a key is minted.
INSERT INTO "site_principals" ("site_id", "created_at", "updated_at")
SELECT "id", NOW(), NOW() FROM "sites" WHERE "read_key" IS NOT NULL
ON CONFLICT ("site_id") DO NOTHING;

-- Carry each issued read key over as a site token under its current value.
--
-- The key sat in `sites.read_key` in the clear. The framework stores a token
-- as the SHA-256 of its bearer, so writing that digest here makes the very
-- same key a live framework token, and whatever holds it keeps reading
-- without being reissued anything. This is the one place a token row is
-- written by hand rather than by `createToken`, because `createToken` chooses
-- the secret and these secrets already exist. The columns are the ones it
-- writes.
INSERT INTO "oauth_access_tokens"
  ("tokenable_type", "tokenable_id", "user_id", "oauth_client_id", "token", "name", "scopes", "revoked", "expires_at", "created_at", "updated_at")
SELECT
  'site_principals',
  sp."id",
  sp."id",
  (SELECT "id" FROM "oauth_clients" WHERE "personal_access_client" = true AND "revoked" = false ORDER BY "id" LIMIT 1),
  encode(sha256(convert_to(s."read_key", 'UTF8')), 'hex'),
  'Read key',
  '["site:read"]',
  false,
  (NOW() AT TIME ZONE 'UTC') + interval '3650 days',
  (NOW() AT TIME ZONE 'UTC'),
  (NOW() AT TIME ZONE 'UTC')
FROM "sites" s
JOIN "site_principals" sp ON sp."site_id" = s."id"
WHERE s."read_key" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "oauth_clients" WHERE "personal_access_client" = true AND "revoked" = false)
  AND NOT EXISTS (
    SELECT 1 FROM "oauth_access_tokens" t
    WHERE t."token" = encode(sha256(convert_to(s."read_key", 'UTF8')), 'hex')
  );

-- The keys now live, hashed, in the framework's token table.
DROP INDEX IF EXISTS "sites_read_key_unique";
ALTER TABLE "sites" DROP COLUMN IF EXISTS "read_key";
ALTER TABLE "sites" DROP COLUMN IF EXISTS "read_key_last_used_at";
