-- Production analytics storage is PostgreSQL. SQLite already gives varchar
-- columns unconstrained text affinity, so it needs no table rebuild.
ALTER TABLE "custom_events"
  ALTER COLUMN "properties" TYPE text
  USING "properties"::text;
