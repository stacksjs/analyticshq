-- AnalyticsHQ enables the framework newsletter routes, but its application
-- migration corpus predates the framework Subscriber models. Keep the schema
-- here so a clean PostgreSQL database can serve the public signup action.
CREATE TABLE IF NOT EXISTS "subscribers" (
  "id" BIGSERIAL PRIMARY KEY,
  "email" varchar(255) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'subscribed' CHECK ("status" IN ('subscribed', 'unsubscribed', 'pending', 'bounced')),
  "source" varchar(100) DEFAULT 'homepage',
  "unsubscribed_at" timestamp,
  "user_id" bigint REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "subscribers_email_unique" ON "subscribers" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "subscribers_uuid_unique" ON "subscribers" ("uuid");

CREATE TABLE IF NOT EXISTS "subscriber_emails" (
  "id" BIGSERIAL PRIMARY KEY,
  "email" varchar(255) NOT NULL,
  "source" varchar(100) DEFAULT 'homepage',
  "subscriber_id" bigint REFERENCES "subscribers"("id"),
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "subscriber_emails_uuid_unique" ON "subscriber_emails" ("uuid");
