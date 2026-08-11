ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_site_id_fk";
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_site_id_fkey";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id");
