# Privacy Charter

analyticshq is **aggregate-only, cookieless web analytics**. Privacy isn't a
setting here — it's the product. This document is the contract: what we
guarantee, and what we will deliberately never build. It is enforced by
`tests/unit/privacy-guardrails.test.ts`, so the guarantees below fail CI if the
code ever drifts. Tracking issue: [#28](https://github.com/stacksjs/analyticshq/issues/28).

## What we guarantee (invariants)

- **No cookies, no `localStorage`, no `sessionStorage`, no `indexedDB`.** The
  tracker writes nothing to the visitor's device, so no consent banner is needed
  for it. Sessions are derived server-side from an anonymous hash + a 30-minute
  window.
- **No raw IP is ever stored.** The IP is used only as input to a one-way hash
  and then discarded — it is never written to the database.
- **No raw User-Agent is ever stored.** Only a coarse device / browser / OS
  classification is kept.
- **Rotating, per-site visitor hash.** The visitor id is
  `sha256(ip | ua | siteId | UTC-date)`, truncated. Because the salt is the UTC
  date, the id **rotates every 24h** — activity cannot be linked across days.
  Because `siteId` is in the hash, the id is **per-site** — the same person on
  two sites gets two unrelated ids, so there is **no cross-site identity**.
- **Country-only geolocation.** Country is derived from CDN edge headers, then
  the IP is discarded. We do **not** collect city, region, or precise
  coordinates — this is intentionally *stricter* than Plausible/Fathom (which
  moved to city-level).
- **No URL query strings or fragments** are collected from tracked pages.

## What we will never build

These capabilities break the aggregate-only contract that defines privacy-first
analytics. They are out of scope by design, not by omission. A PR that adds any
of them should link here and be rejected unless this charter is explicitly
changed first.

- **Session replay / recordings** (à la Umami v3, Clarity, Matomo)
- **Heatmaps**
- **Individual visitor profiles / per-person session timelines**
- **`identify()` / distinct-user IDs / cross-session identity stitching**
- **City / precise geolocation** — country-only is an invariant
- **Any cookie, `localStorage`, or device-persistent identifier**
- **Retargeting, ad-network, or cross-site tracking**

## How it's enforced

`tests/unit/privacy-guardrails.test.ts` asserts these invariants against the
real tracker/ingest source and the dependency manifest:

- the tracker contains no cookie/storage APIs,
- the ingest populates `country` only (never city/region),
- no session-replay / heatmap / fingerprint / profiling library is declared,
- the visitor hash rotates daily, is per-site, and never leaks the raw IP/UA.

If you're changing tracking, run `./buddy test` — a red guardrail test means the
change needs a privacy review, not a test edit.
