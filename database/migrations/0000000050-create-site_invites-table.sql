-- Pending invitations, so a site can be shared with someone who has no account yet.
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits the
-- file on ";" without first stripping "--" lines, so a semicolon inside a comment
-- ends the statement early and the remainder of the sentence is executed as SQL.
-- See 0000000041 for the run this actually broke.
--
-- WHY A SEPARATE TABLE AND NOT A STATUS COLUMN ON site_members
--
-- The obvious design is one table with a "pending" state and a nullable user_id,
-- filled in on accept. A sibling app does exactly that. It means every query that
-- answers "can this user reach this site" has to remember to filter the pending
-- rows out, and the day one of them forgets, an unaccepted invitation silently
-- becomes access. resolveSiteRole in app/Analytics/access.ts is a LEFT JOIN onto
-- site_members with no status predicate, so that failure would be immediate and
-- total here.
--
-- Keeping the two apart makes the mistake unavailable. A row in site_members IS
-- access, with no qualifier -- which is what every existing query already assumes.
-- An invite is a promise of access, and it grants nothing until it is redeemed.
--
-- WHAT IS STORED IS A HASH
--
-- token_hash holds the SHA-256 of the token, never the token. The raw value exists
-- exactly once, in the email, and cannot be recovered from here. A database dump,
-- a log line or a backup therefore does not hand out standing access to every site
-- with an open invitation.
--
-- EXPIRY IS NOT OPTIONAL
--
-- An invitation that never expires is a permanent bearer credential sitting in a
-- mailbox, and mailboxes are forwarded, breached and inherited. expires_at is set
-- at creation and checked on redemption.
--
-- UNIQUE (site_id, email) mirrors the (site_id, user_id) primary key on
-- site_members -- re-inviting the same address updates the row and reissues the
-- token rather than leaving several live tokens for one person.
CREATE TABLE IF NOT EXISTS "site_invites" (
  "id" bigserial PRIMARY KEY,
  "site_id" varchar(64) NOT NULL,
  "email" varchar(255) NOT NULL,
  "role" varchar(16) NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "invited_by" integer,
  "created_at" varchar(32) NOT NULL,
  "expires_at" varchar(32) NOT NULL,
  "accepted_at" varchar(32)
);
-- Deleting a site takes its open invitations with it. An orphaned invite would
-- otherwise redeem into an id that /collect can re-create as a shadow site.
ALTER TABLE "site_invites" DROP CONSTRAINT IF EXISTS "site_invites_site_id_fk";
ALTER TABLE "site_invites" DROP CONSTRAINT IF EXISTS "site_invites_site_id_fkey";
ALTER TABLE "site_invites" DROP CONSTRAINT IF EXISTS "site_invites_site_id_fk";
ALTER TABLE "site_invites" ADD CONSTRAINT "site_invites_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;
-- The inviter leaving does not revoke what they sent. SET NULL rather than CASCADE
-- so a deleted account cannot quietly withdraw a colleague's pending access.
ALTER TABLE "site_invites" DROP CONSTRAINT IF EXISTS "site_invites_invited_by_fk";
ALTER TABLE "site_invites" DROP CONSTRAINT IF EXISTS "site_invites_invited_by_fkey";
ALTER TABLE "site_invites" DROP CONSTRAINT IF EXISTS "site_invites_invited_by_fk";
ALTER TABLE "site_invites" ADD CONSTRAINT "site_invites_invited_by_fk" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL;
-- Redemption looks the invite up by token and nothing else, so this is the hot
-- path. Unique because two invitations sharing a hash would make one of them
-- redeemable as the other.
CREATE UNIQUE INDEX IF NOT EXISTS "site_invites_token" ON "site_invites" ("token_hash");
-- One live invitation per address per site.
CREATE UNIQUE INDEX IF NOT EXISTS "site_invites_site_email" ON "site_invites" ("site_id", "email");
-- Listing a site's pending invitations renders next to its member list.
CREATE INDEX IF NOT EXISTS "site_invites_site" ON "site_invites" ("site_id");
