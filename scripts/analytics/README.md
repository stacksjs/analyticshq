# Analytics import / export tooling

Small standalone CLIs for moving a site's analytics data in and out of
analyticshq' Postgres. They talk to Postgres **directly** via Bun's built-in
`Bun.SQL` (the framework's `@stacksjs/database` hangs outside its boot context),
driven by env vars with local-dev defaults:

```
DB_HOST=127.0.0.1 DB_PORT=5432 DB_DATABASE=analyticshq DB_USERNAME=$USER DB_PASSWORD=
# …or a single DATABASE_URL=postgres://user:pass@host:5432/db
```

Run them directly (`bun scripts/analytics/<name>.ts …`) or via the package
aliases (`bun run export:site -- …` — note the `--` before flags).

---

## Export a site — `export-site.ts`

```bash
# full re-importable NDJSON archive (all tables, FK-safe order)
bun scripts/analytics/export-site.ts --site=<id> --out=backup.ndjson
bun scripts/analytics/export-site.ts --site=<id> > backup.ndjson   # or stream to stdout

# a single table as CSV (for spreadsheets)
bun scripts/analytics/export-site.ts --site=<id> --format=csv --table=page_views --out=pv.csv
```

Covers `sites, goals, sessions, page_views, custom_events, conversions`. Large
tables are keyset-paginated, so it won't load everything into memory.

## Restore / clone — `import-site.ts`

```bash
# restore an archive (ids preserved; idempotent — ON CONFLICT DO NOTHING)
bun scripts/analytics/import-site.ts --in=backup.ndjson
cat backup.ndjson | bun scripts/analytics/import-site.ts

# clone onto a NEW site id in the same (or another) database
bun scripts/analytics/import-site.ts --in=backup.ndjson --site=<new-id>
```

`--site` re-homes the archive: `site_id` becomes the new id, and every other
row's id + its `session_id`/`goal_id` refs are prefixed, so the clone is fully
independent of the source.

## Import from Fathom — `import-fathom.ts`

Backfills historical data from [Fathom Analytics](https://usefathom.com). Fathom
only stores **aggregates**, so we query `/aggregations` grouped by every
dimension per day and **synthesize** raw `page_views` + `sessions` that reproduce
those totals — visitor/session counts are sized from Fathom's `uniques`/`visits`
and are therefore approximate, but the data then flows through the normal
dashboard exactly like native traffic.

```bash
bun scripts/analytics/import-fathom.ts \
  --token=<fathom-api-token> \
  --fathom-site=<fathom-site-id> \
  --site=<analyticshq-site-id> \
  --from=2021-03-01 --to=2026-07-01 \
  [--with-utm] [--replace] [--dry-run]
```

- **`--dry-run`** — fetch + report totals, write nothing.
- **`--replace`** — delete any prior Fathom import for this site first (synthetic
  rows use `fip_`/`fis_`/`fim_` id prefixes, so real data is never touched).
- **`--with-utm`** — also group by `utm_source/medium/campaign` (more accurate
  campaign history, higher row cardinality).
- **`--mock=<file>`** — read a JSON array of aggregation rows instead of calling
  the API (offline testing).

Notes: Fathom's API is accurate from **March 2021** onwards and rate-limited to
10 req/min on aggregations, so the import chunks by month and paces requests.
Device/browser/OS casing is normalized to match the tracker (`Desktop`→
`desktop`, `Mac OS X`→`macOS`).

> Historical imports older than ~1 year won't show in the dashboard yet — its
> widest range is 1 year. A custom/all-time range is the follow-up to surface
> deep history.
