---
title: Quick start
description: Create a site, install the tracker, and verify the first page view.
---

# Quick start

## 1. Create an account and site

Open [analyticshq.org/register](https://analyticshq.org/register), create an account, and add the site you want to measure. AnalyticsHQ generates an App ID for that site.

## 2. Add the tracker

Copy the installation snippet from the site dashboard. The portable HTML form is:

```html
<script
  defer
  src="https://analyticshq.org/script.js"
  data-site="YOUR_APP_ID"
></script>
```

Add it once to the document head. The script derives the collection endpoint from its own URL, so hosted, self-hosted, local, and verified custom-domain installations all use the same artifact.

Framework-specific examples are in [Install tracking](/tracking/install).

## 3. Verify collection

Visit the tracked site, navigate to a second page, and open the AnalyticsHQ dashboard. The realtime report should show activity shortly after the beacon reaches `POST /collect`.

You can also verify the public tracker and health endpoint:

```bash
curl -I https://analyticshq.org/script.js
curl https://analyticshq.org/api/health
```

## 4. Set up useful outcomes

- Create a [goal](/reports/goals-funnels) for a success page or custom event.
- Add campaign parameters to acquisition links.
- Enable revenue collection only where you have a meaningful transaction value.
- Review [privacy controls](/privacy) before enabling optional region data.

## Troubleshooting

If no data appears, confirm that the App ID is exact, the script returns JavaScript rather than an HTML error page, and the browser is not blocking the request. Do Not Track and Global Privacy Control are respected by default, so a protected browser may intentionally send nothing.
