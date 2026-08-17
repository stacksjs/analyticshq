# Looker Studio connector

Build Looker Studio reports on your analyticshq data. Around five minutes to set up, and you deploy it yourself.

## Why you deploy it rather than installing ours

We publish nothing to Google's connector gallery. Listing there means submitting this product for Google's review and maintaining a relationship with them to keep it listed — for a product whose whole argument is not sending your visitors' data to Google, that is a strange dependency to take on for a reporting convenience.

Deploying it yourself takes one extra step and leaves nothing between you and your data. It is the same reasoning behind the [GA4](../../scripts/analytics/import-ga4.ts) and [Search Console](../../scripts/analytics/import-search-console.ts) importers using service accounts you create rather than an OAuth app we register.

## Setup

**1. Create the Apps Script project**

Go to [script.google.com](https://script.google.com/home/projects/create), create a new project, and name it `analyticshq`.

**2. Add the files**

Replace the contents of `Code.gs` with [`Code.gs`](./Code.gs) from this folder.

Then enable the manifest — Project Settings → "Show `appsscript.json` manifest file in editor" — and replace its contents with [`appsscript.json`](./appsscript.json).

**3. Deploy**

Deploy → New deployment → type **Looker Studio connector** → Deploy. Copy the **Deployment ID**.

**4. Get your share token**

In your analyticshq dashboard, open the site → **Share** → create a share link. The token is the `share=` value in the URL it gives you.

This token is per-site, read-only, and revocable. Rotating or deleting it immediately breaks every report built on it, which is exactly what you want when someone leaves.

**5. Connect**

Open `https://lookerstudio.google.com/datasources/create?connectorId=<YOUR_DEPLOYMENT_ID>`, paste the share token when asked for credentials, and enter your **site ID** — the id from your dashboard URL.

Self-hosting? Put your instance URL in the **Instance URL** field. Leave it blank otherwise.

## What you get

| Dimensions | Metrics |
| --- | --- |
| Date, Page, Source, Country, Device, Browser, OS, Campaign | Pageviews, Visitors, Sessions, Bounces |

The connector requests only the fields your chart uses, so a report grouped by date pulls one row per day rather than one per combination of everything.

## What you deliberately cannot get

There is no visitor or session identifier, and there will not be one. This endpoint returns counts, not people — asking for `visitor_id` as a dimension is refused explicitly rather than treated as a typo. A BI tool is where a per-visitor export would be most tempting and least visible, which is why the restriction lives in the API rather than in this connector.

## Troubleshooting

**"A share token is required"** — the credential was not saved. Edit the data source and re-enter it.

**"That share token is not valid for this site"** — it was rotated or revoked. Create a new share link and update the data source credentials.

**"Sharing is not enabled for this site"** — no share link exists yet. Create one under Share.

**"This range returned more rows than one request can carry"** — narrow the date range. The report is refused rather than truncated, because a chart drawn on part of the data looks like a real decline and nothing on screen would say otherwise.

## Other BI tools

The endpoint is plain HTTP and not Looker-specific:

```
GET /api/connect/{siteId}/report
      ?token=<share token>
      &dimensions=date,path
      &metrics=views,visitors
      &from=2026-01-01&to=2026-01-31T23:59:59.999Z
```

`GET /api/connect/{siteId}/fields` lists every available dimension and metric with its type. Both accept the token as `?token=` or as a `Bearer` header.

Note that `to` is compared against ISO timestamps, so a bare `to=2026-01-31` excludes that day — pass the end of the day as shown.
