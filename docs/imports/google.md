---
title: GA4 and Search Console
description: Bring historical Google Analytics and search performance data into AnalyticsHQ.
---

# GA4 and Search Console

AnalyticsHQ provides separate imports because GA4 traffic and Search Console query performance have different schemas and credentials.

## GA4 import

Use the dashboard endpoint or the CLI to import a supported GA4 export:

```bash
bun run import:ga -- --site=SITE_ID --in=ga4-export.csv --dry-run
```

Review totals before writing. Historical aggregates cannot recreate the exact visitor identity of native AnalyticsHQ events.

## Search Console import

Search Console data adds queries, landing pages, clicks, impressions, click-through rate, and position to the site's search report.

```bash
bun run import:site -- --help
bun scripts/analytics/import-search-console.ts --help
```

Use the script's current `--help` output as the authority for credentials and flags because Google export shapes can change.

## Keep sources separate

Imports are marked so they can be reconciled without overwriting native collection. Run a dry pass first, confirm the site identifier and date range, then write once.
