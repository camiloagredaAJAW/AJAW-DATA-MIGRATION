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

> **`AiSearch` progress sync (2026-07-08).** The migration engine no longer just creates the `AiSearch` parent once and forgets it: `resultsNumber`/`statusSelect` are now pushed back to Axelor once per fetched page/block during a country's run, and once per successful individual retry from the Errors page — not just reflected locally. Progress pushes are best-effort (never fail or block the actual `AiSearchResults` writes); see [`AXELOR_INTEGRATION.md`](./AXELOR_INTEGRATION.md) for the `statusSelect` code table and update contract.

> **Admin UI polish (2026-07-08).** The dashboard now auto-refreshes every 10s (plus a manual Refresh button below "Per-Country Progress"); the Errors table shows each failure's timestamp; `source_catalog` has its own page (`/admin/catalog.html`, `GET /admin/api/catalog`) instead of only a blind refresh button; and "Reset Everything" stays collapsed behind a reveal button (with a Cancel to close it again) instead of sitting open on the dashboard by default.

> **Errors page: pagination, analytics, bulk retry (2026-07-09).** The Errors table now has First/Last controls alongside Prev/Next and pages 100 rows at a time (up from 50). A new "Error Analytics" table breaks down a single UTC day's error counts by hour, with each hour's share of that day's own total — not the whole table's (`GET /admin/api/errors/analytics?day=YYYY-MM-DD`, defaulting to today in the UI, with a date picker to look at a different day). A "Retry Failed (Bulk)" button (`POST /admin/api/errors/retry-bulk`) retries every unresolved error matching the current runId/countryCode filter, in blocks of 20, up to 200 rows per call (click again to continue past that cap) — it's rejected with a 409 while a migration run is actively `running` (pausing first is fine) or while another bulk retry is already in flight, and a migration `start()` is likewise rejected while a bulk retry is running. On the dashboard, "Reset Everything" now matches the plain-heading style of the other sections and only shows its confirmation box after clicking the (now shorter) "Reset" button.

> **Per-country Retry (2026-07-09).** After an incident where a Leads DB/Axelor host outage left several countries `failed` mid-migration, "Per-Country Progress" now has a Retry button on any `failed`/`halted` row (`POST /admin/api/migration/countries/:countryCode/retry`). It resumes just that one country from its saved checkpoint offset and `AiSearch` id — never from zero — so already-saved records aren't recreated; retrying a `halted` (paused/stopped mid-page) row asks for confirmation first, since that specific case can re-save the page it was interrupted on. The dashboard's per-country table now always reflects each country's latest checkpoint across every run (not just the most recent one), so retrying a single country no longer makes every other country disappear from the table, and the "Unresolved errors" count is no longer scoped to just the most recent run. A country's checkpoint also now shows a distinct `running` status while it's actively being processed — separate from `pending` (not started yet) and `halted` (interrupted, not currently active).

> **Dashboard records chart, dark mode, and an Analytics page (2026-07-11).** The migration engine now records each successful save into a new `daily_save_stats` table (one row per UTC day, purely additive — no backfill, so counts only start accumulating from whenever this migration is applied, not retroactively). `GET /admin/api/analytics/daily?granularity=day|week&limit=N` merges that against `import_errors` to return saved-vs-error counts per day or per ISO week; the dashboard now charts it as a stacked bar chart ("Saved vs Error Records", with a Day/Week toggle), capped to roughly 20% of the viewport's height (`min(20vh, 200px)`) so it never dominates the page, with a legend, hover/focus tooltips, and a collapsible table fallback. Every admin page also gets a persisted light/dark theme toggle (sun/moon icon button, top right, remembered via `localStorage`, no flash of the wrong theme on load), and the hourly "Error Analytics" table has moved off the Errors page onto its own `/admin/analytics.html` page. **Deploy note:** the new `daily_save_stats` table is created by migration `010`, applied automatically on every container start (see Docker/deployment below) — after a deploy, "Saved" counts populate starting from the next successful migration run, same as any other migration here.

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

## Docker / deployment

`Dockerfile` builds a single-stage image (`node:20-slim` — glibc, so
`better-sqlite3` installs from a prebuilt binary instead of compiling from
source) and starts the container with `npm run migrate && npm run seed &&
npm run dev:api`. Both `migrate` and `seed` are idempotent, so this is safe
to run on every container start/redeploy, not just the first one.

Two things a deploy platform (e.g. EasyPanel) needs to provide:

- **A persistent volume mounted at `/app/data`** (the container's
  `SQLITE_PATH` default parent directory) — without it, every redeploy starts
  from an empty database, silently discarding field mappings, run history,
  and checkpoints.
- **All the env vars listed in `.env.example`**, set through the platform's
  environment configuration — never baked into the image or committed.

Local build/run smoke test (no real Axelor/Leads DB access needed to confirm
the image boots and serves the admin UI):

```bash
docker build -t ajaw-data-migration .
docker run --rm -p 3000:3000 --env-file .env -v "$(pwd)/data:/app/data" ajaw-data-migration
```

If Axelor is reachable at a real subdomain with a platform-issued certificate
(as opposed to a local mkcert-signed one), TLS should verify normally with no
extra config — the "unable to verify the first certificate" error seen in
local dev is specific to the local self-signed setup, not expected to
reappear once both services are deployed behind real certs.

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
