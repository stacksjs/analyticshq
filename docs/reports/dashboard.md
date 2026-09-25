---
title: Dashboard reports
description: Understand the core AnalyticsHQ traffic and behavior reports.
---

# Dashboard reports

Every dashboard report uses the active site, date range, and filter set. Selecting a row adds a filter so the rest of the page describes the same audience.

## Overview

The overview includes visitors, sessions, page views, pages per session, bounce rate, and duration where available. A timeseries shows change across the selected range.

## Content

Pages, entry pages, and exit pages explain what people viewed and where sessions began or ended. AnalyticsHQ stores paths rather than page titles.

## Acquisition

Referrers and campaign reports cover source, medium, campaign, term, and content values. Use consistent UTM naming so totals remain comparable.

## Technology and geography

Device, browser, operating system, and country are derived without storing raw user-agent strings or IP addresses. Region rows appear only when both the installation and the site have enabled region collection, and city rows (`San Diego, CA`) only when they have enabled city collection. Clicking a region narrows the cities panel to that state.

Selecting the United States on the country map applies `country=US`; the region and city panels then narrow to the US automatically.

## Realtime

Realtime activity is a short current window, not a replacement for the selected historical range. Use it to validate a new installation and to watch launches.
