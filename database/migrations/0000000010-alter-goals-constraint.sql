ALTER TABLE "goals" DROP CONSTRAINT IF EXISTS "goals_site_id_fk";
ALTER TABLE "goals" DROP CONSTRAINT IF EXISTS "goals_site_id_fkey";
ALTER TABLE "goals" ADD CONSTRAINT "goals_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id");
