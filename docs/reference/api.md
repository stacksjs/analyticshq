---
title: HTTP API
description: A categorized reference to AnalyticsHQ collection, report, management, and public endpoints.
---

# HTTP API

Dashboard APIs require the authenticated session unless described as public. Every site-scoped operation verifies membership or ownership on the server.

## Collection

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/collect` | Record page views, events, conversions, and vitals |
| `GET` | `/script.js` | Browser tracker |
| `GET` | `/api/health` | Service and geolocation health |

## Sites and access

| Methods | Path |
| --- | --- |
| `GET`, `POST` | `/api/sites` |
| `PATCH`, `DELETE` | `/api/sites/{siteId}` |
| `GET`, `POST` | `/api/sites/{siteId}/members` |
| `DELETE` | `/api/sites/{siteId}/members/{userId}` |
| `GET`, `POST` | `/api/sites/{siteId}/invites` |
| `POST` | `/api/invites/accept` |

## Reports

Site report routes include `/stats`, `/timeseries`, `/pages`, `/entry-pages`, `/exit-pages`, `/referrers`, `/events`, `/realtime`, `/revenue`, `/vitals`, `/vitals-trends`, `/search`, and geographic and technology breakdowns.

Common query parameters include the date range and filter dimensions. Use `GET /api/filters` to discover the current filter catalog.

## Goals, funnels, and segments

| Methods | Path |
| --- | --- |
| `GET`, `POST` | `/api/sites/{siteId}/goals` |
| `DELETE` | `/api/sites/{siteId}/goals/{goalId}` |
| `GET`, `POST` | `/api/sites/{siteId}/funnels` |
| `PATCH`, `DELETE` | `/api/sites/{siteId}/funnels/{funnelId}` |
| `GET` | `/api/sites/{siteId}/funnels/{funnelId}/results` |
| `GET`, `POST` | `/api/sites/{siteId}/segments` |
| `PATCH`, `DELETE` | `/api/sites/{siteId}/segments/{segmentId}` |

## Imports and integrations

Authenticated import endpoints exist for Fathom, GA4, and Search Console. Connector consumers can read the permitted field catalog and a bounded report through `/api/connect/{siteId}/fields` and `/api/connect/{siteId}/report`.

## Public output

Public summary, badge, and sparkline endpoints expose only sites whose sharing or widget setting permits it.

For exact request fields and response shapes, consult `routes/analytics.ts`. It is the current wire-contract implementation.
