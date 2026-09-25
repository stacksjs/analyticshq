---
title: Privacy model
description: Understand AnalyticsHQ collection defaults, visitor hashing, geography, suppression, and retention.
---

# Privacy model

Privacy behavior is declared centrally in `config/privacy.ts`. The defaults are part of the product contract, not generic toggles.

## Default guarantees

- Analytics cookies are not set.
- Raw IP addresses are not stored.
- Visitor hashes rotate with a site-specific daily salt.
- Do Not Track and Global Privacy Control are respected.
- Page titles and screen dimensions are not collected.
- Geography is country-level unless a site explicitly opts into region or city on an installation that permits it.
- Coordinates, postcodes and accuracy radii are never collected.

## Visitor identity

The collector uses request information only long enough to derive a daily, site-scoped hash. Salts are retained for two days so events around UTC midnight can be assigned consistently, then become unavailable.

## Geography

Location is resolved locally from a trusted CDN country header when present or from the configured DB-IP database. The IP is discarded after lookup.

Region and city collection each have three gates:

1. `geo.granularity` must permit the level (`region`, or `city`, which also permits region).
2. The site owner must enable `region_geo` or `city_geo`.
3. The configured database must contain subdivision and city data (DB-IP City Lite).

The country database satisfies only country lookup. A city is stored as its name with its region, for example `US-CA:San Diego`. Small region and city rows are combined into `Other`.

## Filter disclosure control

Filtered reports with fewer than `ANALYTICSHQ_MIN_SEGMENT_SIZE` distinct visitors are refused. The default is 5. Set the value to `0` only for a deliberate private installation that accepts the disclosure tradeoff.

## Retention

`ANALYTICSHQ_RETENTION_DAYS` controls raw analytics retention. A value of `0` disables pruning. The scheduled prune script applies the policy to stored data.
