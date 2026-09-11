---
title: Custom events
description: Record product actions and use them in goals and funnels.
---

# Custom events

Custom events describe meaningful actions that are not page views, such as completing onboarding, starting checkout, or exporting a report.

## Send an event

After the tracker loads, call its event API with a stable event name and optional properties. Keep names short and product-oriented.

```js
window.tsAnalytics?.track('Signup completed', {
  plan: 'pro',
  source: 'pricing',
})
```

Framework integrations expose the same behavior through their typed helpers. For example, the Nuxt module auto-imports `useTsAnalytics()` and the Vue plugin provides a typed `track()` surface.

## Choose good event names

- Describe the outcome, not the click target.
- Keep the spelling and capitalization stable.
- Do not put email addresses, names, tokens, or free-form customer content in event properties.
- Use a property for a variant instead of creating a new event name for every variant.

## Use events in reports

Events appear in the dashboard event report. You can turn an event into a [goal](/reports/goals-funnels) or use multiple events and pages as ordered funnel steps.
