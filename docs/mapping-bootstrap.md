# Field Mapping Registry — Bootstrap & API

Operational SQLite registry of source-to-destination field mappings, seeded
from a pre-deduced dataset and kept up to date by an idempotent CLI. A thin
authenticated HTTP API exposes the registry for read/update.

## Prerequisites

- Node.js >= 20
- Copy `.env.example` to `.env` and fill in every value. All required
  variables are documented there:
  - `AXELOR_USERNAME` / `AXELOR_PASSWORD` — reused as the Basic Auth
    credential pair for this tool's API (a direct comparison, not a live
    call to Axelor).
  - `AXELOR_BASE_URL`, `AJAW_NAMESPACE`, `MODEL_NAME_COMPANIES`,
    `MODEL_NAME_PEOPLE` — Axelor destination context for later migration
    slices.
  - `INTERNAL_API_KEY` — required value for the `X-Internal-Api-Key` request
    header on every API call.
  - `LEADS_DB_BASE_URL`, `LEADS_DB_ALL`, `LEADS_DB_EXPORT`,
    `LEADS_DB_QP_KEY_VALUE` — Leads DB endpoint used by the live-sampling CLI
    commands (`refresh-catalog`, `sample --refresh`).
  - `SQLITE_PATH` (optional) — path to the SQLite file; defaults to
    `data/mapping.db`.
  - `PORT` (optional) — API server port; defaults to `3000`.

Install dependencies:

```bash
npm install
```

## Running migrations

Creates `data/mapping.db` (or `SQLITE_PATH`) and applies every
`src/migrations/NNN_*.sql` file in order, tracked in `schema_migrations`:

```bash
npm run migrate
```

Safe to rerun — already-applied migrations are skipped.

## Seeding the database (first run)

Loads the committed 832-row deduced dataset
(`references/leads-mapping/field-mappings.deduced.json`) into
`field_mappings`. Only needed once, on a fresh database — rerunning is
idempotent and will not duplicate rows or overwrite admin-edited rows:

```bash
npm run seed
```

## Refreshing from the live Leads DB

Re-samples the live Leads DB to discover new tables and re-deduce mappings
for columns not already protected by an admin edit. This hits the network
and is opt-in — the CLI requires an explicit `--refresh` flag before it will
sample:

```bash
npm run refresh
```

This runs `refresh-catalog` (updates `source_catalog` from `/dbs`) followed
by `sample --refresh` (samples up to 3 rows per table and re-deduces
`field_mappings`). To target a single table instead of the whole catalog,
call the CLI directly:

```bash
npx tsx src/cli/bootstrap.ts sample --refresh --db ar --table companies
```

Rows whose `origin` is `admin` (edited via the API) are never overwritten by
a rerun of `seed`, `refresh-catalog`, or `sample`.

## Running the API server

```bash
npm run dev:api
```

Starts a Fastify server (default port `3000`, override with `PORT`) exposing
the authenticated `field_mappings` endpoints. Every request MUST include
BOTH:

- An `Authorization: Basic <base64(username:password)>` header, checked
  against `AXELOR_USERNAME`/`AXELOR_PASSWORD`.
- An `X-Internal-Api-Key` header, checked against `INTERNAL_API_KEY`.

Missing or invalid credentials on either check return `401` with no data.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/field-mappings?source_db=&source_table=` | List, optionally filtered |
| GET | `/api/field-mappings/:id` | Read one; `404` if not found |
| PUT | `/api/field-mappings/:id` | Update `destinationField`/`transform`; always sets `origin=admin`; `404` if not found; `400` on invalid payload |

Create and delete are intentionally not exposed via the API in this slice —
the registry is bootstrapped/seeded, not manually authored from scratch.

Example:

```bash
curl -u admin:s3cret \
  -H "X-Internal-Api-Key: $INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -X PUT http://localhost:3000/api/field-mappings/42 \
  -d '{"destinationField": "title"}'
```

## Running tests

```bash
npm test          # single run
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit
```

All tests use an in-memory SQLite database and mocked `fetch` for the Leads
DB client — no network access or real server binding required.
