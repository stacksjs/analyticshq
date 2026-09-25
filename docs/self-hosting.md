---
title: Self-hosting
description: Run AnalyticsHQ with Bun, Stacks, PostgreSQL, and optional local geolocation.
---

# Self-hosting

## Requirements

- Bun 1.3 or newer
- PostgreSQL for concurrent ingest and report queries
- SQLite 3.47.2 or newer for local development

## Local setup

```bash
git clone https://github.com/stacksjs/analyticshq.git
cd analyticshq
bun install
cp .env.example .env
./buddy key:generate
./buddy migrate
bun run dev
```

The view server and API use separate local ports. Trust the URLs printed by the development command if you changed `config/ports.ts`.

## Production configuration

At minimum, configure the application URL and key, PostgreSQL connection, mail delivery, queue driver, and proxy behavior. Leave Stripe variables empty for a self-hosted installation; plan limits and hosted billing gates then remain inactive.

## Geolocation database

The deploy workflow installs the DB-IP City Lite database, falling back to Country Lite if it cannot be fetched. Set the `ANALYTICSHQ_GEO_CITY` repository variable to `false` to ship Country Lite instead, and `ANALYTICSHQ_GEO_DB` to override the file's location. Region and city collection require City Lite, a `geo.granularity` that permits them, and each site's own opt-in. `/api/health` reports `geoRegion` and `geoCity` so you can confirm what the installed file can answer.

## Processes

Production serves the stx application and the API as separate processes behind one origin. The API owns `/collect` and `/api/*`; the application server renders pages and proxies those requests internally.

## Health

Monitor `GET /api/health`. It checks core service health and reports whether country and region geolocation are available.
