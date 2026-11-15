-- The list of addresses mail must not be sent to: hard bounces, complaints,
-- unsubscribes and manual blocks. @stacksjs/email reads it before every send.
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on semicolons without first stripping comment lines.
--
-- Why it was absent: it is the table of the framework's EmailSuppression
-- model, and an app with its own app/Models does not receive the framework's
-- model migrations. Without it the mail layer logs that suppression is "NOT
-- enforced" and sends to every address, so a bounce or an unsubscribe recorded
-- by the framework was dropped and the address was written to again.
--
-- The same columns and unique index as the model's generated migration.
-- `email` is stored lower-cased and trimmed, which is how it is looked up.
-- `type` is one of bounce, complaint, unsubscribe, manual.
--
-- Hand-written and additive, with no app/Models/*.ts behind it.
CREATE TABLE IF NOT EXISTS "email_suppressions" (
  "id" SERIAL PRIMARY KEY,
  "email" varchar(320) NOT NULL,
  "type" varchar(32) NOT NULL CHECK ("type" IN ('bounce', 'complaint', 'unsubscribe', 'manual')),
  "reason" text,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_suppressions_email_type_unique" ON "email_suppressions" ("email", "type");
