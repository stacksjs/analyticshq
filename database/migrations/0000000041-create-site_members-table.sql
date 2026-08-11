-- Per-site membership, so a site can be reached by more than its creator (#19).
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits the
-- file on ";" without first stripping "--" lines, so a semicolon inside a comment
-- ends the statement early and the remainder of the sentence is executed as SQL.
-- The first draft of this file said "takes its memberships with it; the site
-- DELETE endpoint already cascades" and the run failed with
-- `syntax error at or near "the"`. The runner also rewrote this file in place.
--
-- WHY A MEMBERSHIP TABLE AND NOT A TEAM
--
-- The framework ships a team system (@stacksjs/auth team.ts, RBAC role packs) and
-- this deliberately does not use it. A team is a group a user belongs to, which
-- fits a product where people share one workspace. An analytics product is the
-- other shape: an agency holds sites for a dozen clients who must never see each
-- other, and a freelancer is a viewer on one site and an admin on another. That is
-- an edge between a user and a SITE, not a group both belong to. Teams would need
-- one team per client to express it, which is this table with an extra hop.
--
-- sites.owner_id stays. The owner is not a membership row: it is who created the
-- site, who cannot be removed, and who is left holding it when every member is
-- gone. Making the owner an ordinary row would allow a site with no owner, and
-- nothing in billing or deletion has an answer for that.
--
-- ROLES
--
--   viewer  read the reports
--   admin   the above, plus settings, goals, share links and members
--
-- Owner is implied by sites.owner_id and outranks both. Destructive operations,
-- meaning deleting the site or erasing its data, stay owner-only: an admin is
-- someone trusted with reports and settings, not with irreversibly destroying a
-- client's history.
--
-- The primary key is (site_id, user_id), so a user has exactly one role per site
-- and re-inviting an existing member updates rather than duplicates.
CREATE TABLE IF NOT EXISTS "site_members" (
  "site_id" varchar(64) NOT NULL,
  "user_id" integer NOT NULL,
  "role" varchar(16) NOT NULL,
  "created_at" varchar(32) NOT NULL,
  PRIMARY KEY ("site_id", "user_id")
);
-- Deleting a site takes its memberships with it. The site DELETE endpoint already
-- cascades events and goals by hand, and an orphaned membership row would grant
-- access to an id that /collect can re-create as a shadow site.
ALTER TABLE "site_members" DROP CONSTRAINT IF EXISTS "site_members_site_id_fk";
ALTER TABLE "site_members" DROP CONSTRAINT IF EXISTS "site_members_site_id_fk";
ALTER TABLE "site_members" DROP CONSTRAINT IF EXISTS "site_members_site_id_fkey";
ALTER TABLE "site_members" ADD CONSTRAINT "site_members_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;
ALTER TABLE "site_members" DROP CONSTRAINT IF EXISTS "site_members_user_id_fk";
ALTER TABLE "site_members" DROP CONSTRAINT IF EXISTS "site_members_user_id_fkey";
ALTER TABLE "site_members" ADD CONSTRAINT "site_members_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
-- "which sites can I reach" runs on every dashboard load and every site list.
CREATE INDEX IF NOT EXISTS "site_members_user" ON "site_members" ("user_id");
