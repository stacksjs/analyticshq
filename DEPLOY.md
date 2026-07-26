# Deploying analyticshq

analyticshq deploys to the **shared Hetzner box** owned by the `stacks` project
through **ts-cloud** (`./buddy deploy` → `@stacksjs/ts-cloud`). It never
provisions: `config/cloud.ts` sets `cloud.attachTo: 'stacks'`, so the deploy
resolves the existing `stacks-<env>-app` server, ships only analyticshq's sites,
and adds its own additive rpx fragment + DNS.

DNS for **analyticshq.org** is managed at **Porkbun**, auto-detected by ts-cloud
from the domain's nameservers.

## Prerequisites

Set in `.env` (already wired locally):

| Var | Purpose |
|-----|---------|
| `APP_DOMAIN=analyticshq.org` | Primary domain |
| `SSL_DOMAINS=analyticshq.org,www.analyticshq.org` | Certificate SANs |
| `PORKBUN_API_KEY` / `PORKBUN_SECRET_KEY` | Porkbun DNS API |
| `HCLOUD_TOKEN` | Hetzner API — read access to resolve the owner's box |
| `DB_PASSWORD` | Password for the `analyticshq` Postgres role |

## Sites

Two services on the shared box, both behind the rpx gateway:

| Site | Port | What it is |
|------|------|------------|
| `main` | 3024 | `buddy serve` — STX views, plus a same-origin proxy to the API |
| `api`  | 3025 | bun-router — the `/collect` ingest and `/api/*` stats routes |

`main` is the only site with a `domain`; `api` is deliberately domain-less so
the rpx gateway skips it and it stays loopback-only, reachable exclusively
through `main`'s proxy. `main` pins `API_URL=http://127.0.0.1:3025` — without
that it defaults to `:3008`, which on this shared box is the `stacks` project's
own API.

### What the views server forwards

`buddy serve` forwards only `/api/*` and mutating methods (POST/PUT/PATCH/
DELETE) to the API; everything else renders as an STX view. Two consequences the
routes are written around:

- the tracker is the **static** `public/script.js`, not a route — a `GET
  /script.js` on the API would be unreachable from the public origin;
- the health endpoint is `/api/health`, not `/health`.

## Database

PostgreSQL 18 (pantry) co-located on the shared box, listening on
`127.0.0.1:5432` and already serving other tenants. analyticshq gets its own
role + database, created idempotently on every deploy from
`infrastructure.appDatabase` — ts-cloud's attach-mode path runs the same setup
script the provisioning path splices into cloud-init, touching only our role and
database and never the engine install (the box owner manages that).

Migrations in `database/migrations/` are dialect-neutral quoted-identifier DDL,
so they apply to Postgres unchanged:

```sh
./buddy migrate
```

> Replaces the managed SingleStore cluster this app originally shipped against.
> analyticshq is a single-box app whose entire dataset is one project's
> pageviews, so a distributed columnstore bought nothing while costing an
> external dependency, a second network hop, and TLS on every query. Postgres
> rather than SQLite because ingest is append-heavy and concurrent with the
> dashboard's aggregate reads, which a single-writer file lock would serialize.

## Accounts and credentials

Sites are owner-scoped — a site with no owner collects data but is invisible in
the dashboard. `scripts/account.ts` manages that from the box (or anywhere with
`DB_*` pointed at it):

```sh
./buddy                                   # or: bun scripts/account.ts …
bun scripts/account.ts --list                                    # users, their sites, unowned sites
bun scripts/account.ts --create --email=you@example.com --name="You"
bun scripts/account.ts --rotate --email=you@example.com           # new password + revoke live tokens
bun scripts/account.ts --attach --site=zig-utils --email=you@example.com
bun scripts/account.ts --revoke-tokens --email=you@example.com
```

A generated password is printed once to stdout and stored nowhere else.
Rotating always revokes existing access and refresh tokens — otherwise the old
session keeps working and the rotation locks nobody out.

## Deploy

Push to `main` — GitHub Actions runs the production deploy. Or locally:

```sh
./buddy deploy
```

> Live DNS records on a shared production box. Run only when ready.
