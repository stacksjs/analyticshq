---
title: What is AnalyticsHQ
description: A practical overview of AnalyticsHQ and its privacy-first data model.
---

# What is AnalyticsHQ

AnalyticsHQ is an open-source web analytics application. It collects a deliberately small event payload, stores it in your database, and turns it into reports for traffic, acquisition, behavior, conversions, performance, and revenue.

It can run as the hosted service at `analyticshq.org` or as a self-hosted Stacks application.

## What it measures

The browser tracker records page paths, referrers, campaign parameters, device and browser families, country-level location by default, custom events, conversion values, and Core Web Vitals. The dashboard derives sessions, visitors, entry and exit pages, realtime activity, goals, and funnels from that data.

## What it does not collect

AnalyticsHQ does not set analytics cookies. It does not store raw IP addresses, page titles, screen dimensions, or city names. A visitor identifier is hashed with a site-specific daily salt, which prevents durable cross-day profiles.

Region tracking is optional. The installation operator must permit it, the site owner must enable it, and the local geolocation database must contain subdivision data. City tracking has no supported path.

## Main concepts

| Concept | Meaning |
| --- | --- |
| Site | One tracked web property, identified by an App ID |
| Page view | A visit to a path, enriched with privacy-safe dimensions |
| Session | A sequence of activity within the configured inactivity window |
| Custom event | A named action sent by the application |
| Goal | A conversion rule based on a page or event |
| Funnel | An ordered set of page or event steps |
| Segment | A reusable collection of report filters |

## Next steps

Start with the [quick start](/getting-started), then read [install tracking](/tracking/install) for framework-specific setup.
