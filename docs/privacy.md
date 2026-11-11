---
title: Privacy model
description: Understand AnalyticsHQ collection defaults, visitor hashing, geography, suppression, and retention.
---

# Privacy model

Privacy behavior is declared centrally in `config/privacy.ts`. The defaults are part of the product contract, not generic toggles.

## Default guarantees

- Analytics cookies are not set.
- Raw IP addresses are not stored.
- Visitor hashes rotate with a site-specific daily salt. The one exception is an app install on a site whose owner turned on app mode, described below.
- Do Not Track and Global Privacy Control are respected.
- Page titles and screen dimensions are not collected.
- Geography is country-level unless a site explicitly opts into region or city on an installation that permits it.
- Coordinates, postcodes and accuracy radii are never collected.

## Visitor identity

The collector uses request information only long enough to derive a daily, site-scoped hash. Salts are retained for two days so events around UTC midnight can be assigned consistently, then become unavailable.

## App mode

A site owner can let a native or desktop app report to a site. It is off for every site until its owner turns it on, and a request that claims to come from an app is refused on any other site.

An app in app mode sends a random install id that the app itself created and stores. This is different from the web tracker, which stores nothing on a visitor's device, and it is why app mode is meant for apps that ask their users first.

- The install id is never stored. The collector stores a keyed hash of it, and the key belongs to that one site.
- The key does not rotate, so one install stays one visitor from day to day. That is the purpose of the feature, and it is the difference from the daily web hash.
- The same install id sent to two sites produces two unrelated ids. Nothing links an install across sites.
- The IP address and the User-Agent are not part of the id and are not stored. Country, and region or city where the site opted in, are resolved from the IP as for web traffic.
- The app can reset its id at any time by creating a new one. The old and new ids cannot be connected.
- Turning app mode off deletes the site's key. Ids already recorded can then never be tied to an install id again.
- The app's name, its version, the operating system and its major and minor version are recorded. Nothing else about the machine is.
- Filtered reports over app data are subject to the same minimum segment size as web data.

A site that uses app mode holds a pseudonymous identifier for as long as its data is retained. Say so in the app's privacy policy, make sending it opt-in, and offer the reset.

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
