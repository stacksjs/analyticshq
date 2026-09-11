---
title: Import from Fathom
description: Import a Fathom dashboard export or backfill through the Fathom API.
---

# Import from Fathom

The dashboard upload is a Pro capability on the hosted service and is available without a paid plan when self-hosted.

## Dashboard export

Export the standard dashboard data from Fathom and upload the ZIP file exactly as Fathom provides it. AnalyticsHQ previews the date range and totals before writing data.

The importer reads the summary, pages, countries, devices, browsers, and operating systems needed to reproduce Fathom's main totals. Large date ranges are split into safe windows.

Fathom Custom Export, the queued email export whose files are named `pageviews-*.csv`, is detected and refused. Referrers, entry and exit pages, events, and UTM breakdown files are currently reported as skipped rather than partially imported.

## API backfill CLI

```bash
bun run import:fathom -- \
  --token=FATHOM_API_TOKEN \
  --fathom-site=FATHOM_SITE_ID \
  --site=ANALYTICSHQ_SITE_ID \
  --from=2024-01-01 \
  --to=2026-01-01 \
  --dry-run
```

Remove `--dry-run` after reviewing the totals. Add `--replace` to remove a prior synthetic Fathom import for the same site before writing it again. Real AnalyticsHQ rows are not deleted by that option.

Fathom supplies aggregates rather than raw visits. AnalyticsHQ creates synthetic sessions and page views that reproduce the reported totals, so historical visitor and session identities are approximate.
