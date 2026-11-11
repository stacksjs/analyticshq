---
title: Desktop and mobile apps
description: Record opt-in, anonymous usage from a native or desktop app with app mode and the app client.
---

# Desktop and mobile apps

The browser tracker is built for web pages. A native or desktop app is a different client: its agent talks HTTP through Bun, Node or an embedded webview, and it has no page to load a script on. **App mode** is how such an app reports to AnalyticsHQ.

Use it for opt-in, anonymous usage: which screens people open, which features they use, which versions and operating systems are in the field.

## Why a plain request does not work

Two things stop an app from posting to `/collect` the way a browser does.

- **The bot filter.** Requests whose User-Agent names `Bun/`, `undici`, `node-fetch`, Electron, `curl` and similar are dropped with a `204` and nothing is stored. That is correct for a website, where those are scripts, not people.
- **The daily visitor id.** A web visitor's id is derived from the IP address and browser under a key that changes every day. One install would look like a new visitor every morning, and again on every network.

App mode addresses both, and only for sites that ask for it.

## Turn it on

App mode is off for every site. The site **owner** turns it on in the dashboard under the site's settings, in the row "Accept events from an app", or with the API:

```bash
curl -X PATCH https://analyticshq.org/api/sites/YOUR_APP_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"appMode": true}'
```

Use a separate site for your app unless you want its screens in the same reports as your website's pages. A site in app mode still accepts ordinary browser traffic exactly as before, bot filter included.

Turning it off (`{"appMode": false}`) refuses app events from then on and deletes the key that install ids are hashed with. Events already recorded stay in your reports. Turning it on again starts every install as a new visitor.

## Send events with the app client

The `@ts-analytics/tracking` package ships a client for this. It needs `fetch` and nothing else: no DOM, no storage, no dependencies.

```ts
import { createAppClient } from '@ts-analytics/tracking/app'

const analytics = createAppClient({
  endpoint: 'https://analyticshq.org',
  siteId: 'YOUR_APP_ID',
  installId: settings.installId, // a UUID your app created and stored
  appVersion: '1.4.2',
  appName: 'Fettler',
  os: { name: 'macOS', version: '15.1' },
  enabled: settings.shareUsage, // your user's choice
})

await analytics.screen('Settings')
await analytics.track('Export', { format: 'csv' })
```

| Option | Purpose |
| --- | --- |
| `endpoint` | Your AnalyticsHQ host, or its full `/collect` URL |
| `siteId` | The site's App ID |
| `installId` | A random UUID your app generates once and keeps. See below |
| `appVersion` | Up to 32 characters, no spaces, for example `1.4.2` |
| `appName` | Optional. Shown in the Browsers report in place of a browser name |
| `os` | Optional. A name, or `{ name, version }`. The name is read from `process.platform` when omitted. The version is never guessed |
| `enabled` | The opt-in switch. Nothing is sent while it is `false` |
| `environment` | Optional label, the same as the tracker's `data-environment` |
| `batch` | Optional. `true`, or `{ maxSize, flushInterval }`, queues events. Call `flush()` before the app quits |
| `onError` | Optional. Called with the reason when an event is not delivered |

`screen(name)` records a page view (`pageview(name)` is the same call). `track(name, properties)` records a custom event. `setEnabled(false)` stops sending and `setInstallId(id)` swaps the install id after a reset.

The client never throws into your app. Every call resolves, with `false` when the event was not delivered, whether that was no network, a refusal from the server or a bad option. Lost events are not retried.

### The install id

Your app creates the install id, for example with `crypto.randomUUID()`, stores it with its own settings, and sends it. AnalyticsHQ never stores it. It stores a hash of it under a key that belongs to your site alone, so:

- one install is one visitor across days and across networks,
- the same install id sent to another site gives an unrelated id there, and
- deleting the stored id in your app and creating a new one makes that install a new, unlinked visitor. Offer this as a "reset" next to your opt-in switch.

Ask before you send anything, and say what you collect in your privacy policy. See the [privacy model](/privacy#app-mode).

## Where app data appears

App events use the columns the web reports already read, so nothing new has to be learned.

| What the app sent | Where it shows |
| --- | --- |
| `screen('Settings')` | Top pages, as the path `/Settings` |
| `track('Export', { format: 'csv' })` | Events. Its properties also carry `app_version`, `os` and `os_version` |
| `appName` and `appVersion` | Browsers, as the app's name. The version is stored with each screen view |
| `os` | Operating systems, with the same names web traffic uses (`macOS`, `Windows`, `Linux`, `iOS`, `Android`) |
| the device | Devices: `desktop`, or `mobile` for iOS and Android |

The `browser` and `os` filters work on app traffic, and filtered reports are withheld below the [minimum segment size](/privacy#filter-disclosure-control) exactly as they are for web traffic. The OS version is stored as major and minor only: `15.1.1` becomes `15.1`.

Country, and region or city when the site has opted into them, are resolved from the request's IP address the same way as for the web. The IP address is not stored.

## The request, if you are not using the client

```http
POST /collect
Content-Type: application/json

{
  "s": "YOUR_APP_ID",
  "e": "pageview",
  "u": "app://fettler/Settings",
  "app": {
    "id": "3f2b8c1e-9a4d-4e7b-b1c2-0d9e8f7a6b5c",
    "version": "1.4.2",
    "name": "Fettler",
    "os": "macOS",
    "osVersion": "15.1"
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `s` | yes | The site's App ID |
| `e` | no | `pageview` (the default) for a screen, or the event's name |
| `u` | no | A URL whose path is the screen, for example `app://fettler/Settings` |
| `p` | no | An object of event properties |
| `app.id` | yes | The install id: a canonical UUID, 36 characters |
| `app.version` | yes | Up to 32 characters of letters, digits, `.`, `+`, `_` and `-` |
| `app.name` | no | Up to 32 characters. Stored as `App` when absent or unusable |
| `app.os` | no | `macOS`, `Windows`, `Linux`, `iOS`, `Android` (also `darwin`, `win32` and similar), or a short label of your own |
| `app.osVersion` | no | Cut to major and minor |
| `environment` | no | A short label, as for the web tracker |

The `app` object is what declares app mode. No header is required and the User-Agent is not checked, so the same request works from an agent process and from a webview. The client sets a descriptive User-Agent, `Fettler/1.4.2 (macOS 15.1) ts-analytics-app/<version>`, where the runtime allows it.

| Status | Meaning |
| --- | --- |
| `204` | Recorded. Also returned when the request carries `Sec-GPC: 1` and nothing was stored |
| `400` | `app.id` is not a UUID, `app.version` is missing or malformed, `app` is not an object, or the event is `vitals` |
| `403` | The site is not in app mode, or does not exist |

A request **without** an `app` object is web traffic, on every site. From a `Bun/` or `undici` User-Agent it is still dropped with a `204`.
