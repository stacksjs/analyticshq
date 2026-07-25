# Deploying analyticshq

analyticshq deploys to AWS through **ts-cloud** (`stacks buddy deploy` → `@stacksjs/ts-cloud`).
DNS for **analyticshq.org** is managed at **Porkbun**.

## Prerequisites

Set in `.env` (already wired locally):

| Var | Purpose |
|-----|---------|
| `APP_DOMAIN=analyticshq.org` | Primary domain |
| `SSL_DOMAINS=analyticshq.org,www.analyticshq.org` | ACM certificate SANs |
| `PORKBUN_API_KEY` / `PORKBUN_SECRET_KEY` | Porkbun DNS API (ACM validation + records) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS credentials |
| `DB_CONNECTION=singlestore` + `DB_*` | SingleStore connection (managed Helios or self-hosted) |

`config/cloud.ts` sets `project.name = analyticshq`, `dns.domain = analyticshq.org`, and ACM SSL.
ts-cloud **auto-detects Porkbun** as the DNS provider from the domain's nameservers.

## Database

SingleStore speaks the MySQL wire protocol (port 3306); `generate:migrations`
emits FK-free DDL with `SHARD KEY` / `SORT KEY` (migrations in `database/migrations/`).

- **Dev / cloud:** point `DB_*` at a SingleStore cluster — a free managed
  [Helios](https://www.singlestore.com/cloud-trial/) workspace (set `DB_SSL=true`)
  or a self-hosted `singlestoredb-dev` container — then `./buddy migrate`.
  (SingleStore is not a Pantry package; unlike bughq's Postgres it has no local
  Pantry service.)

## Deploy

```sh
./buddy deploy            # provisions AWS infra + Porkbun DNS, ships the app
```

> Provisioning creates billable AWS resources and live DNS records. Run only when ready.
