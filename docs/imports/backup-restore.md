---
title: Backup and restore
description: Export a complete site archive, restore it, or clone it under a new site identifier.
---

# Backup and restore

The standalone tools connect directly to PostgreSQL through `Bun.SQL`. Supply individual database variables or `DATABASE_URL`.

## Export a site

```bash
bun run export:site -- --site=SITE_ID --out=backup.ndjson
```

The NDJSON archive includes sites, goals, sessions, page views, custom events, and conversions in foreign-key-safe order. Large tables use keyset pagination.

Export one table for spreadsheet analysis:

```bash
bun run export:site -- \
  --site=SITE_ID \
  --format=csv \
  --table=page_views \
  --out=page-views.csv
```

## Restore

```bash
bun run import:site -- --in=backup.ndjson
```

IDs are preserved and conflicts are ignored, which makes the operation safe to retry.

## Clone to another site

```bash
bun run import:site -- --in=backup.ndjson --site=NEW_SITE_ID
```

Cloning rewrites the site ID and prefixes dependent identifiers so the copy remains independent of the source.
