---
title: CLI reference
description: Commands for developing, validating, importing, exporting, and operating AnalyticsHQ.
---

# CLI reference

## Application commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the local application and API |
| `./buddy migrate` | Apply pending migrations |
| `./buddy generate:migrations` | Generate model-driven schema changes |
| `./buddy test` | Run the Bun test suite |
| `bun run typecheck` | Run TypeScript checks |
| `./buddy lint` | Run the configured linter |
| `./buddy build docs` | Build this BunPress site |

## Data movement

| Command | Purpose |
| --- | --- |
| `bun run export:site -- ...` | Export NDJSON or one CSV table |
| `bun run import:site -- ...` | Restore or clone an AnalyticsHQ archive |
| `bun run import:fathom -- ...` | Backfill from the Fathom API |
| `bun run import:ga -- ...` | Import a supported Google Analytics export |

Pass `--help` to the underlying script before an operational run. Start imports with `--dry-run` when supported.

## Documentation

```bash
./buddy dev docs
./buddy build docs
```

The production build is written to `dist/docs/.bunpress`.
