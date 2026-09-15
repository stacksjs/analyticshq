---
title: Revenue and Web Vitals
description: Connect conversion value with traffic and monitor user-facing performance.
---

# Revenue and Web Vitals

## Revenue

Revenue reports associate a numeric conversion value and currency with tracked outcomes. Use the smallest monetary unit consistently in the sending application, and never place payment credentials or customer details in analytics properties.

Revenue is reported within the active site, range, and filters. It is intended for attribution and trend analysis, not accounting reconciliation.

## Core Web Vitals

AnalyticsHQ records five browser performance metrics:

| Metric | Meaning |
| --- | --- |
| LCP | Largest Contentful Paint |
| INP | Interaction to Next Paint |
| CLS | Cumulative Layout Shift |
| FCP | First Contentful Paint |
| TTFB | Time to First Byte |

Vitals are enabled by the installation policy and can be disabled for one site with `data-vitals="false"`. AnalyticsHQ stores the metric, numeric value, and path. It does not need a visitor's screen dimensions or page title.

Use the trends report to find regressions across releases or periods. Browser measurements vary naturally, so compare distributions and trends rather than treating one sample as a verdict.
