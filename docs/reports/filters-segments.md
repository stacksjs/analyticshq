---
title: Filters and segments
description: Narrow reports safely and save reusable audiences.
---

# Filters and segments

Filters narrow every compatible report on the dashboard. Segments save a set of filters so it can be applied again.

## Available dimensions

AnalyticsHQ supports dimensions such as path, referrer, country, region when enabled, device, browser, operating system, campaign values, and event names. The API exposes the current filter catalog at `GET /api/filters`.

## Combine filters

Multiple filters describe their intersection. A country and device filter, for example, means visitors matching both values.

## Privacy threshold

Filtered reports are withheld when they describe fewer distinct visitors than `ANALYTICSHQ_MIN_SEGMENT_SIZE`, which defaults to 5. Unfiltered site totals are not suppressed. Low-volume region rows are combined into `Other` instead of exposing a tiny subdivision.

This is expected behavior. It prevents several harmless-looking filters from identifying one visitor when composed.

## Save a segment

Create a segment from the current filters, give it a clear audience name, and reuse it in dashboards and funnels. Segment creation and editing require access to the site.
