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
  `sha256(ip | ua | siteId | salt)`, truncated, where the salt is a random
  per-site secret. By default the salt is new every UTC day, so the id
  **rotates every 24h** and activity cannot be linked across days. Because
  `siteId` is in the hash, the id is **per-site**: the same person on two sites
  gets two unrelated ids, so there is **no cross-site identity**. A salt is
  deleted once its day is over, and from then on nobody, including us, can tie
  that day's ids to an IP or browser. An IPv6 address goes into the hash cut to
  its /64 network, because the rest is a privacy address the device changes
  every day or so. That is the same granularity an IPv4 address already has
  behind a home router, so the hash sees less of the address, not more.

- **Visitor timelines are opt-in, pseudonymous and capped at 30 days.** A site
  owner can turn on "Remember returning visitors". That site then keeps one salt
  for a fixed 30-day block of the calendar instead of one day, so a returning
  visitor keeps the same id for the rest of the block and the dashboard can show
  their visits, pages, sources, events and conversions over that time. It is off
  for every site until its owner turns it on, and the install can forbid it
  (`maxVisitorWindowDays` in `config/privacy.ts`). Still no cookie, nothing read
  from or stored on the visitor's device, no raw IP or user agent, no name or
  email, and no `identify()`. When the block ends its salt is deleted and its ids
  can never be linked again, and turning the setting off deletes the site's
  long salt at once. The id is built from the IP and browser, so a visitor who
  changes network shows up as someone new: it is a best effort, not an identity.
  A site that turns this on holds pseudonymous personal data for up to 30 days
  and should say so in its privacy policy. Site owners can erase one visitor's
  data from the visitor's page.
- **Country geolocation by default. Region and city only if you turn them on.**
  Country is resolved on your own server, by an IP-to-country database held on
  that machine, and the IP is discarded in the same breath it is hashed into the
  visitor id. Nothing is sent to a third party to ask where a visitor is. (If
  something upstream of you already resolved a country and passed it along, that
  is used instead and no lookup happens, but nothing depends on it, which is
  the bug this sentence used to have: it named that as the only mechanism, on a
  product whose own production host has nothing upstream of it.)

  A site owner may opt that site into **region** (state or province, ISO 3166-2)
  and, separately, into **city** (the city's name, stored with its region as
  `US-CA:San Diego`). **Both are off for every site until that site's owner turns
  them on**, which is what makes country the location this product records by
  default. A site that opts into city records its region too, since the city
  value already names it.

  The install has to permit them as well (`geo.granularity` in
  `config/privacy.ts`, which allows city, and therefore region, by default; set
  it to `'region'` to take city away from site owners, `'country'` to take both,
  or `'none'` to record no location at all), and the server has to be running a
  geolocation database that carries subdivisions and cities. DB-IP's country
  file does not; the deploy workflow ships City Lite unless
  `ANALYTICSHQ_GEO_CITY=false`.

  Region and city rows are subject to the disclosure floor: any state or city
  with fewer than `minSegmentSize` visitors (5 by default) is reported as
  "Other" rather than named. The install's operator can set a different floor
  for one site, including 0, which names every state and city on that site
  (`scripts/account.ts --segment-size`). Site owners cannot change it from the
  dashboard or the API.

  **Precise coordinates are never collected, at any setting.** City is a place
  name and nothing finer: no latitude or longitude, no accuracy radius, no
  postcode. `cityFromIp` reads the city's English name and never the record's
  location block. The live map puts a dot on a named city by looking the NAME
  up in a gazetteer of place centres, built offline from the same database at
  deploy time (`scripts/geo/build-city-points.ts`): every record for a city is
  averaged into one point and rounded to 0.1 degree, about 11km. It locates
  places, never visitors, and only places that already cleared the site's
  disclosure floor. This remains stricter than Plausible/Fathom, which resolve
  every visitor to city level with no way to turn it down.
- **No URL query strings or fragments** are collected from tracked pages.

## What we will never build

These capabilities break the aggregate-only contract that defines privacy-first
analytics. They are out of scope by design, not by omission. A PR that adds any
of them should link here and be rejected unless this charter is explicitly
changed first.

- **Session replay / recordings** (à la Umami v3, Clarity, Matomo)
- **Heatmaps**
- **Individual visitor profiles beyond the opt-in 30-day timeline above**: no
  id that outlives its block, and nothing that follows a person across sites
- **`identify()` / distinct-user IDs / linking a visitor to a name, email or
  account**
- **Precise geolocation / coordinates / postcodes**: the geo line stops at the
  city's name, and region and city are each off unless a site owner opts in
- **Any cookie, `localStorage`, or device-persistent identifier**
- **Retargeting, ad-network, or cross-site tracking**

## How it's enforced

`tests/unit/privacy-guardrails.test.ts` asserts these invariants against the
real tracker/ingest source and the dependency manifest:

- the tracker contains no cookie/storage APIs,
- the ingest populates `region` and `city` only through their gated lookups,
  and only for a site that opted in on an install that permits it,
- no session-replay / heatmap / fingerprint / profiling library is declared,
- the visitor hash rotates daily, is per-site, and never leaks the raw IP/UA,
- a site keeps one salt for longer than a day only when its owner opted in, and
  never for more than `maxVisitorWindowDays`, and expired salts are purged by
  the daily prune job whether or not event retention is on.

If you're changing tracking, run `./buddy test` — a red guardrail test means the
change needs a privacy review, not a test edit.
