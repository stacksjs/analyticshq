-- Social sign-in columns: which provider an account signed in with, its id
-- there, and the avatar it shared.
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on semicolons without first stripping comment lines.
--
-- WHY NOW
--
-- app/Actions/Auth/SocialCallbackAction.ts has always written these three on
-- every GitHub or Google sign-in, and no migration ever created them. So with
-- the providers configured in production, each social sign-in threw on that
-- write and answered 500. A returning user never got in, and a new one got an
-- account (register runs first) and no session. /api/me had the same gap on
-- the read side and now reads them apart from created_at.
--
-- app/Models/User.ts declares all three, guarded and hidden, so the schema
-- differ keeps them and no request body can set them. varchar(255), the width
-- the differ gives a model string, so it has nothing to alter. Nullable:
-- password accounts have none of them.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "provider" varchar(255);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "provider_id" varchar(255);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar" varchar(255);
