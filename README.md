# Ajaw Data Migration

Controlled, resumable migration tool that extracts company leads from a remote Leads Database and persists them into Axelor (AJAWMRP), which owns functional persistence. This app never becomes a second source of truth for lead data — its only durable state is operational: field mappings, migration progress (breadcrumbs), and error records.

Full product context lives in [`PRD.md`](./PRD.md). Read that first for goals, non-goals, and architecture decisions.

## Status

| Slice | Status |
|---|---|
| 1. Mapping bootstrap (schema, CLI, seed, CRUD API) | Implemented (3 chained PRs), being revised for the Leads DB source change below |
| 2. Migration engine core (extraction, sanitization, Axelor client, sequential save, checkpointing) | Planned |
| 3. Migration controls (start/pause/resume/stop, error recovery) | Planned |
| 4. Admin front end (login, dashboard, mapping editor, controls) | Planned |

> **Leads DB source changed (2026-07-06).** The remote source moved from a per-`source_db`/`source_table` model to a single `/companies?country=<CODE>` endpoint iterated over country codes. The Person-lead domain (LinkedinSearch/LinkedinSearchResults) is no longer in scope — see [`PRD.md` §16 Revision History](./PRD.md#16-revision-history) and [`LEADS_DATABASE.md`](./LEADS_DATABASE.md).

## Stack

Node.js + TypeScript, `better-sqlite3` (operational SQLite state — never a copy of lead data), Fastify (authenticated API), Vitest (Strict TDD — tests are written before implementation).

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
npm run dev:api      # start the authenticated field_mappings API
npm test             # run the test suite
npm run typecheck    # tsc --noEmit
```

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
