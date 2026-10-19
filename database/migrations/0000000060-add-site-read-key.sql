-- A read-scoped site key, so a machine can read this site's analytics without
-- holding a person's credentials (stacksjs/analyticshq#67).
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on semicolons without first stripping comment lines.
--
-- WHY NOW
--
-- Every read here resolves a signed-in user, and the only issuable bearer
-- belongs to a human. A Stacks dashboard reading a site server-to-server had
-- nothing correct to hold, so selecting the hosted provider rendered empty.
--
-- Unlike loghq and bughq there was no per-site credential to extend. The
-- tracker is a public script beaconing to a site id, so this is a new
-- credential rather than a second mode on an old one.
--
-- This one returns data, so it is a secret. 256 bits, compared in constant
-- time in app/Support/read-key.ts, and accepted only on the reads listed on
-- that issue rather than on all forty-odd site routes.
--
-- Both nullable because a key is issued on demand and revoking sets it back to
-- NULL, which is also why uniqueness is a partial index: every site without a
-- key would otherwise collide.
--
-- read_key_last_used_at tells somebody whether a key is still in use before
-- they revoke it. Written at most once a minute per key, not per request.
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "read_key" varchar(255);
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "read_key_last_used_at" varchar(255);
CREATE UNIQUE INDEX IF NOT EXISTS "sites_read_key_unique" ON "sites" ("read_key") WHERE "read_key" IS NOT NULL;
