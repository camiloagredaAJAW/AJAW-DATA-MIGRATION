# Ajaw Data Migration

Controlled, resumable migration tool that extracts company leads from a remote Leads Database and persists them into Axelor (AJAWMRP), which owns functional persistence. This app never becomes a second source of truth for lead data — its only durable state is operational: field mappings, migration progress (breadcrumbs), and error records.

Full product context lives in [`PRD.md`](./PRD.md). Read that first for goals, non-goals, and architecture decisions.

## Status

All four PRD slices are implemented. The migration tool is usable end-to-end: bootstrap/curate field mappings, run the migration engine, control/monitor/retry via either the authenticated `/api/*` HTTP surface or the session-authenticated `/admin/*` browser UI.

| Slice | Status |
|---|---|
| 1. Mapping bootstrap (schema, CLI, seed, CRUD API) | Implemented (3 chained PRs) |
| 2. Migration engine core (extraction, sanitization, Axelor client, sequential save, checkpointing) | Implemented |
| 3. Migration controls (start/pause/resume/stop, error recovery) | Implemented |
| 4. Admin front end (login, dashboard, mapping editor, error review, controls) | Implemented (4 chained PRs) |

> **Leads DB source changed (2026-07-06).** The remote source moved from a per-`source_db`/`source_table` model to a single `/companies?country=<CODE>` endpoint iterated over country codes. The Person-lead domain (LinkedinSearch/LinkedinSearchResults) is no longer in scope — see [`PRD.md` §16 Revision History](./PRD.md#16-revision-history) and [`LEADS_DATABASE.md`](./LEADS_DATABASE.md).

## Stack

Node.js + TypeScript, `better-sqlite3` (operational SQLite state — never a copy of lead data), Fastify, Vitest (Strict TDD — tests are written before implementation).

Fastify serves two sibling, independently-authenticated route scopes on one instance:
- `/api/*` — Basic Auth + `X-Internal-Api-Key`, for machine/CLI/integration callers (`fieldMappings`, `migrationControl`).
- `/admin/*` — session-cookie auth (`@fastify/cookie` + `@fastify/session`, in-memory store) plus a CSRF header check on state-changing requests, for the browser admin UI. `/admin/api/*` is a thin BFF over the same in-process repo/controller functions `/api/*` uses — no duplicated business logic. Static admin pages (`public/*.html/.js/.css`, no build step/framework) are served via `@fastify/static`.

## Prerequisites

- Node.js >= 20
- Copy `.env.example` to `.env` and fill in every value (Axelor credentials, Leads DB base URL/key, `INTERNAL_API_KEY`, `LEADS_DB_PAGE_LIMIT`, etc.)

```bash
npm install
```

## Common commands

```bash
npm run migrate      # apply SQLite migrations (idempotent)
npm run seed         # load the committed field-mappings seed dataset
npm run refresh      # re-sample the live Leads DB and deduce mappings for genuinely new columns
npm run dev:api      # start the API (/api/*) and the admin UI (/admin/*, /admin/login.html)
npm test             # run the test suite
npm run typecheck    # tsc --noEmit
```

## Running a migration (first-time setup)

The engine picks the countries to process from `source_catalog`, a cached
snapshot of the Leads DB's `/dbs` response — **not** from `field_mappings`
directly. `npm run seed` only populates `field_mappings`; `source_catalog`
starts empty and stays empty until it's explicitly refreshed. Starting a
migration with an empty `source_catalog` is not an error: the run silently
iterates zero countries and marks itself `completed` immediately, with no
checkpoints and no errors — worth knowing before assuming a `completed` run
with nothing in "Per-Country Progress" actually did something.

Required order for a fresh database:

```bash
npm run migrate                                    # 1. create the schema
npm run seed                                       # 2. load field_mappings
npx tsx src/cli/bootstrap.ts refresh-catalog        # 3. populate source_catalog from the live /dbs
npm run dev:api                                     # 4. start the server, then hit Start from /admin/dashboard.html
```

Step 3 hits the live Leads DB (needs `LEADS_DB_*` from `.env`) but is
lightweight — it only fetches the country list, unlike `sample --refresh`
(part of `npm run refresh`), which re-samples rows per country to deduce
mappings. Only countries present in **both** `source_catalog` and
`field_mappings` actually get migrated.

## Documentation map

| Doc | Covers |
|---|---|
| [`PRD.md`](./PRD.md) | Product requirements, architecture, key decisions, data model, migration flow, revision history |
| [`LEADS_DATABASE.md`](./LEADS_DATABASE.md) | Remote Leads DB API reference (countries, `/companies` endpoint, pagination) |
| [`AXELOR_INTEGRATION.md`](./AXELOR_INTEGRATION.md) | Axelor/AJAWMRP REST integration reference (auth, models, request/response shapes) |
| [`docs/mapping-bootstrap.md`](./docs/mapping-bootstrap.md) | Usage guide for the implemented mapping-bootstrap slice (migrations, seed, CLI, API) |
| [`references/leads-mapping/`](./references/leads-mapping/) | Live-sampled field-mapping dataset (source columns → Axelor `AiSearchResults` fields) used as seed data |
| [`references/ajawmrp/models/`](./references/ajawmrp/models/) | Axelor domain model XML references |

## Development process

This project is built with Spec-Driven Development (SDD): every change goes through proposal → spec → design → tasks → apply → verify → archive, with Strict TDD (test-first) during apply. Implementation history and decisions are tracked in the project's persistent memory (Engram), not duplicated into this README.
