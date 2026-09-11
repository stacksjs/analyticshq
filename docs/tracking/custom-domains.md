---
title: Custom domains
description: Serve the tracker and collector from a verified first-party subdomain.
---

# Custom domains

A custom domain lets a site load `script.js` and send `/collect` requests through a first-party hostname such as `stats.example.com`.

## Configure DNS

1. Open the site settings in AnalyticsHQ.
2. Enter the analytics subdomain.
3. Add the displayed CNAME record at your DNS provider.
4. Return to AnalyticsHQ and verify the domain.

AnalyticsHQ only emits a custom-domain snippet after verification succeeds. Before that, the dashboard continues to use the regular application origin so a newly installed tracker does not silently point at unready DNS.

## Install the verified snippet

```html
<script defer src="https://stats.example.com/script.js" data-site="YOUR_APP_ID"></script>
```

The tracker sends data back to the origin that served it. No separate collector URL is required.

## Operational notes

- Keep the CNAME in place while the snippet is deployed.
- Verify TLS before changing production sites.
- Removing the domain in AnalyticsHQ returns future snippets to the normal origin, but existing tags must still be updated by the site owner.
