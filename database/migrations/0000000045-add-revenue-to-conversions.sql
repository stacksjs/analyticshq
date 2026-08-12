-- Dynamic revenue and currency on conversions (#22).
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on ";" without first stripping "--" lines, so a semicolon inside a
-- comment ends the statement early and the rest of the sentence runs as SQL.
--
-- WHY NOT REUSE THE EXISTING value COLUMN
--
-- conversions.value and goals.value are integers already in use, holding
-- whatever number the goal's creator typed. Nothing records whether that number
-- meant dollars or cents, and nothing records what currency it was. Repurposing
-- the column would silently reinterpret every existing row -- a goal worth "50"
-- would become 50 cents or stay 50 dollars depending on which reader you asked,
-- and there is no way to tell from the data which was meant.
--
-- So the money columns are new, the old ones are left alone, and the ambiguity
-- stays confined to rows written before this migration.
--
-- MINOR UNITS, ALWAYS
--
-- amount_minor is a whole number of the currency's smallest unit: cents for USD,
-- yen for JPY. Money in a float drifts when summed, and the drift surfaces as a
-- revenue total that disagrees with the customer's own books by a few cents and
-- cannot be explained. bigint rather than integer because 2.1 billion minor units
-- is only 21 million dollars, which a real store passes.
--
-- The exponent is NOT always 2 -- see app/Analytics/money.ts. JPY has none, KWD
-- has three. Storing minor units without storing the currency would make the
-- number meaningless, which is why the two columns are added together and why
-- nothing reads one without the other.
--
-- CURRENCY LIVES ON THE ROW
--
-- Not just on the site. A business selling in more than one currency writes rows
-- in each, and totals are reported PER CURRENCY and never summed across them --
-- adding dollars to euros requires an exchange rate, and inventing one to make a
-- single headline number would be fabricating the figure. sites.currency is only
-- a default for events that arrive without one.
ALTER TABLE "conversions" ADD COLUMN IF NOT EXISTS "amount_minor" bigint;
ALTER TABLE "conversions" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
-- A goal can carry a default amount, used when an event does not send its own --
-- a fixed-price product does not need the front end to repeat the price on every
-- purchase.
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "default_amount_minor" bigint;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
-- The site's default currency, for events and goals that do not name one.
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
-- Revenue is read as "sum by currency over a window for this site", so the index
-- carries currency to keep the grouping off the heap.
CREATE INDEX IF NOT EXISTS "conversions_revenue" ON "conversions" ("site_id", "timestamp", "currency");
