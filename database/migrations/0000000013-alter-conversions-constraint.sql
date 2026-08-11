ALTER TABLE "conversions" DROP CONSTRAINT IF EXISTS "conversions_site_id_fk";
ALTER TABLE "conversions" DROP CONSTRAINT IF EXISTS "conversions_site_id_fkey";
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id");
ALTER TABLE "conversions" DROP CONSTRAINT IF EXISTS "conversions_goal_id_fk";
ALTER TABLE "conversions" DROP CONSTRAINT IF EXISTS "conversions_goal_id_fkey";
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "goals"("id");
ALTER TABLE "conversions" DROP CONSTRAINT IF EXISTS "conversions_session_id_fk";
ALTER TABLE "conversions" DROP CONSTRAINT IF EXISTS "conversions_session_id_fkey";
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "sessions"("id");
