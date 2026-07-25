# analyticshq Stats API

A JSON HTTP API over your analytics data. Every site-scoped endpoint is
**owner-gated** — you can only read or manage sites you own.

## Authentication

Get a bearer token by logging in, then send it on every request:

```bash
TOKEN=$(curl -s -X POST https://your-host/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"…"}' | jq -r .token)

curl -s https://your-host/api/sites/<SITE_ID>/stats \
  -H "Authorization: Bearer $TOKEN"
```

Unauthenticated requests get `401`; a request for a site you don't own gets
`403` (or `404` if it doesn't exist). Site ids are public (they ride in the
tracking snippet), which is exactly why every read is owner-scoped.

## Time window

All report endpoints accept an optional window. Values are ISO timestamps or
`YYYY-MM-DD` dates; the default is the **last 7 days**.

| Param | Meaning |
|-------|---------|
| `from` | Start of the window (inclusive) |
| `to`   | End of the window (inclusive) |

```
GET /api/sites/<id>/stats?from=2026-06-01&to=2026-06-30
```

## Filters

The page-view reports (`stats`, `timeseries`, `pages`, `referrers`, and the
breakdown endpoints below) accept the same filter dimensions the dashboard uses.
They **compose with AND**:

`path`, `source`, `referrer`, `country`, `device`, `browser`, `os`,
`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`

```
GET /api/sites/<id>/pages?country=US&device=Mobile
GET /api/sites/<id>/stats?source=Google
```

## Reports

All return JSON. `views` = pageviews, `visitors` = unique visitors (a
24h-rotating, per-site hash), `sessions` = distinct sessions.

| Endpoint | Response |
|----------|----------|
| `GET /api/sites/{id}/stats` | `{ views, visitors, sessions, range: { from, to } }` |
| `GET /api/sites/{id}/timeseries` | `{ series: [{ day, views, visitors }] }` |
| `GET /api/sites/{id}/pages` | `{ pages: [{ path, views, visitors }] }` |
| `GET /api/sites/{id}/referrers` | `{ referrers: [{ source, views, visitors }] }` |
| `GET /api/sites/{id}/countries` | `{ countries: [{ name, views, visitors }] }` |
| `GET /api/sites/{id}/devices` | `{ devices: [{ name, views, visitors }] }` |
| `GET /api/sites/{id}/browsers` | `{ browsers: [{ name, views, visitors }] }` |
| `GET /api/sites/{id}/operating-systems` | `{ operating_systems: [{ name, views, visitors }] }` |
| `GET /api/sites/{id}/utm/sources` | `{ sources: [{ name, views, visitors }] }` |
| `GET /api/sites/{id}/utm/mediums` | `{ mediums: [{ name, views, visitors }] }` |
| `GET /api/sites/{id}/utm/campaigns` | `{ campaigns: [{ name, views, visitors }] }` |
| `GET /api/sites/{id}/events` | `{ events: [{ name, events, visitors }] }` |
| `GET /api/sites/{id}/entry-pages` | `{ entry_pages: [{ path, sessions, visitors }] }` |
| `GET /api/sites/{id}/exit-pages` | `{ exit_pages: [{ path, sessions, visitors }] }` |
| `GET /api/sites/{id}/realtime` | `{ current }` — unique visitors in the last 5 min |

Breakdown lists are capped at the top 20 by views. (Filters don't apply to
`events`, `entry-pages`, or `exit-pages` yet — those come from other tables.)

## Site management

| Endpoint | Purpose |
|----------|---------|
| `GET /api/sites` | List the sites you own |
| `POST /api/sites` | Create a site — `{ name, domain? }` → `{ site }` |
| `PATCH /api/sites/{id}` | Edit `name`, `domains`, or `timezone` (IANA); partial |
| `DELETE /api/sites/{id}` | Delete the site and cascade-erase all its data |

## Goals & sharing

| Endpoint | Purpose |
|----------|---------|
| `GET /api/sites/{id}/goals` | List goals |
| `POST /api/sites/{id}/goals` | Create a goal |
| `DELETE /api/sites/{id}/goals/{goalId}` | Delete a goal |
| `POST /api/sites/{id}/share` | Mint/rotate a read-only share token |
| `DELETE /api/sites/{id}/share` | Revoke the share token |

## Data deletion & erasure

| Endpoint | Purpose |
|----------|---------|
| `DELETE /api/sites/{id}/data` | Wipe all analytics rows for a site (keeps the site + goals) |
| `DELETE /api/sites/{id}/visitors/{visitorId}` | GDPR erasure for one visitor id |

> The `visitorId` is a 24h-rotating hash, so per-visitor erasure only reaches
> the rows sharing that id (in practice one UTC day) — there is no durable key
> that could reach further back, by design.

## Data import (CLI)

Backfill history from another provider — run on the server (needs DB env vars):

```bash
bun import:ga --site=<id> --file=<ga4-export.csv>        # Google Analytics (GA4)
bun import:fathom --site=<id> --token=… --fathom-site=…  # Fathom
```
