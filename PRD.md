# PRD — Ajaw Data Migration

> **Revision note (2026-07-06)**: the Leads DB source model changed after this PRD was first written — see §16 Revision History. Company-only scope; the earlier per-`source_db`/`source_table` iteration and the Person domain (LinkedinSearch/LinkedinSearchResults) are no longer part of this PRD.

## 1. Overview

Ajaw Data Migration is a controlled, resumable migration tool that extracts company lead records from a remote Leads Database and persists them into Axelor (AJAWMRP), which owns functional persistence. The app itself must never become a second source of truth for lead data — its only durable state is operational: field mappings, migration progress (breadcrumbs), and error records.

The app ships with a minimal admin-only front end to monitor migration progress and control the process (start, pause, resume, stop).

## 2. Goals

- Migrate company leads from the remote Leads DB into Axelor's `AiSearch`/`AiSearchResults` domain.
- Support pausing/resuming/stopping the migration without data loss or duplication, even after a crash.
- Let an administrator adjust source-to-destination field mappings without a code change.
- Sanitize malformed/illegible data before it reaches Axelor.
- Keep Axelor as the single source of truth for lead data.

## 3. Non-Goals

- No multi-user admin accounts or role management — single shared admin credential.
- No editing of migrated lead data from this app once persisted in Axelor.
- No parallel/distributed workers across countries in v1 (volume is moderate — tens of thousands of records; a single sequential worker is sufficient).
- No batch/bulk create against Axelor — Axelor requires one-record-at-a-time saves.
- **No person-lead domain.** The current Leads DB source only exposes company data (`/companies`); LinkedinSearch/LinkedinSearchResults is out of scope until an equivalent person-lead source endpoint exists.

## 4. Users

Single role: **Administrator**. Authenticates with the credentials defined in `AXELOR_USERNAME` / `AXELOR_PASSWORD` and uses the panel to monitor and control the migration and to edit field mappings.

## 5. Architecture Overview

- **Stack**: Node.js + TypeScript for both the migration engine and the API; a minimal admin frontend served from the same app.
- **Internal state store**: SQLite — holds field mappings, migration run/checkpoint state (breadcrumbs), and the error log. This is operational metadata only, never a copy of lead data.
- **External systems**:
  - Leads DB (remote, read-only, paginated via `limit`/`offset`) — see [`LEADS_DATABASE.md`](./LEADS_DATABASE.md).
  - Axelor/AJAWMRP (system of record for leads) — see [`AXELOR_INTEGRATION.md`](./AXELOR_INTEGRATION.md).

```text
Leads DB  --(paginated export, one batch at a time)-->  Migration Engine  --(sequential create, 1 record at a time)-->  Axelor
                                                              |
                                                     SQLite (mappings, breadcrumbs, error log)
                                                              |
                                                      Admin API + minimal front end
```

## 6. Key Decisions (resolved during discovery)

| Decision | Choice | Rationale |
|---|---|---|
| Stack | Node.js + TypeScript | Fits sequential I/O-heavy workload against two REST APIs; native JSON; simple SQLite driver; can serve the admin front end from the same process. |
| Admin login | Direct comparison against `AXELOR_USERNAME`/`AXELOR_PASSWORD` from `.env` | Decouples the admin panel's availability from Axelor's own login endpoint. The migration engine maintains its own Axelor session (via `login.jsp`) independently, whenever it needs to call the REST API. |
| Source iteration unit | Per-country (`country` query param), single `/companies` endpoint | The Leads DB source no longer exposes multiple databases/tables per country — only one company-leads endpoint, filtered by `country`. `field_mappings` keeps its existing `source_db`/`source_table` columns for schema stability: `source_db` now holds the country code (e.g. `AR`, `BR`), `source_table` is always the constant `"companies"`. |
| Person-lead domain | Dropped from scope | The source only exposes company data. LinkedinSearch/LinkedinSearchResults is not implemented until an equivalent person-lead source exists. |
| Leads DB result filters | `has_phone=1&has_email=1` fixed, not configurable | Only leads with a phone and an email are worth migrating; no need for an admin toggle in v1. |
| Duplicate prevention on resume | Internal breadcrumb ledger only (no Axelor `search` check before create) | Faster (avoids doubling HTTP calls at this volume); the ledger is the authoritative checkpoint. Acceptable given moderate volume and single sequential worker. |
| Error handling per record | Skip + log, continue migration | A single bad record must not halt the whole run. Failed records are recorded with their reason and stay available for manual review/retry from the admin panel. |
| API authentication scope | Basic Auth (`AXELOR_USERNAME`/`AXELOR_PASSWORD`) + `INTERNAL_API_KEY` on **all** API endpoints | Status queries, start/pause/resume/stop, and mapping edits are all behind the same authenticated API; the admin front end consumes this same API after login. |
| Expected volume | Moderate (tens of thousands of records) | A single sequential worker (per Axelor's one-record-at-a-time constraint) is sufficient; no need to parallelize by country in v1. |
| Pagination page size | Configurable via `LEADS_DB_PAGE_LIMIT` env var | Real migration pagination (`limit`/`offset` on `/companies`) reads its page size from this env var, so it can be tuned per environment without a code change. The 3-record mapping-bootstrap sample stays hardcoded, independent of this setting. |

## 7. Field Mapping Bootstrap (pre-development step)

Before building/adjusting the migration engine, sample **3 records** from each country (via `/companies?country=<CODE>&has_phone=1&has_email=1&format=jsonl&key=...&limit=3&offset=0`) and, for each, produce a mapping record:

```text
country_code | source_column -> destination_field (AiSearchResults)
```

- Every mapping targets `AiSearchResults` (company) — there is no classification step anymore, since the source only exposes company data (see §6).
- Stored in SQLite as the seed data for the `field_mappings` table (`source_db` = country code, `source_table` = constant `"companies"`, for schema continuity with the original design).
- Columns with no reasonable destination field are mapped to `null`/ignored explicitly (not left ambiguous), so the admin can see coverage per country. Business identifiers with no dedicated Axelor field (tax IDs, internal row IDs) are preserved inside `additionalInfo` rather than dropped, same policy as before.

## 8. Data Model (SQLite — operational state only)

- **`source_catalog`**: cached result of `/dbs?key=...` — now just the list of country codes (the `databases` object in that response is obsolete and unused).
- **`field_mappings`**: `source_db` (country code), `source_table` (always `"companies"`), `source_column`, `destination_domain` (always `AiSearchResults`), `destination_field`, `transform` (optional sanitization rule reference), editable from the admin front end.
- **`migration_runs`**: one row per migration run — status (`running`/`paused`/`stopped`/`completed`/`failed`), started/updated timestamps.
- **`migration_checkpoints`** (breadcrumbs): per country code, last successfully processed `offset`, so a resume picks up exactly where it left off.
- **`import_errors`**: failed record's source identity (country code, raw offset/index), error reason, timestamp, resolved flag — surfaced in the admin panel for manual retry.

## 9. Migration Flow

1. Fetch the country list (`/dbs`) and iterate the keys of `countries` (e.g. `AR`, `BR`, `CO`, ...).
2. For each country with a mapping configured:
   1. Resume from the last checkpoint (`offset`) if one exists.
   2. Fetch a batch from `/companies?country=<CODE>&has_phone=1&has_email=1&format=jsonl&key=...&limit=<LEADS_DB_PAGE_LIMIT>&offset=<offset>`.
   3. For each record in the batch, **sequentially**:
      - Sanitize field values (see §10).
      - Apply the field mapping to build the `AiSearchResults` payload.
      - Ensure the parent `AiSearch` record exists for the run/batch context; create it if needed and reuse its `id`.
      - `PUT` the child `AiSearchResults` record to Axelor.
      - On success: advance and persist the checkpoint.
      - On failure: write to `import_errors`, advance the checkpoint anyway (so the run keeps moving), continue to the next record.
   4. Advance `offset` by `LEADS_DB_PAGE_LIMIT` and repeat until the country returns fewer records than requested (exhausted).
3. Mark the run `completed` when all mapped countries are exhausted.

## 10. Sanitization Rules

Applied per field before mapping into the Axelor payload, primarily via regular expressions:

- Strip/replace control characters and non-printable Unicode.
- Fix common mojibake/encoding artifacts where detectable.
- Trim leading/trailing whitespace; collapse internal whitespace runs.
- Normalize `null`-like string literals (e.g. `"null"`, empty string) consistently before mapping.
- Reject or null out values that remain illegible after cleanup, rather than forwarding garbage to Axelor.

Sanitization rules are defined per `field_mappings.transform` so they can evolve without code changes where feasible; complex/non-regex transforms remain code-defined.

## 11. Migration Controls & Breadcrumbs

- Admin can **start**, **pause**, **resume**, and **stop** a run from the panel; these map to authenticated API calls.
- Pause/stop always persist the current checkpoint before halting, so resume is always safe.
- On unexpected crash, the last persisted checkpoint is the recovery point on next `resume`.

## 12. Admin Front End (minimal)

- Login screen (credential compare against `.env`).
- Dashboard: current run status, per-table progress (processed/total, last offset), error count.
- Mapping editor: view/edit `field_mappings` per `source_db`/`source_table`.
- Error review: list `import_errors`, allow manual retry of individual records.
- Controls: start / pause / resume / stop buttons.

## 13. Security

- Admin panel session gated by direct comparison to `AXELOR_USERNAME`/`AXELOR_PASSWORD` env values.
- All API endpoints require Basic Auth (same credentials) **and** `INTERNAL_API_KEY` sent via the `X-Internal-Api-Key` header (not a query param — avoids leaking the key into access logs/URLs).
- No credentials, tokens, or session cookies are ever persisted in SQLite, logs, or documentation.

## 14. Open Risks / Assumptions

- Axelor session cookie (`JSESSIONID`/`CSRF-TOKEN`/`TENANTID`) lifetime and renewal policy is not yet confirmed — the migration engine must detect an expired session and re-authenticate transparently mid-run.
- Some countries return fields whose meaning differs from their name across countries (e.g. `city` came back as a numeric internal code, not a city name, for Brazil in a live sample) — confirmed case by case during the mapping bootstrap sampling, not assumed.
- Some countries may return 0 rows at sampling time (the source only exposes "already scraped this session" data) — not an error, just re-sample later.
- Exact env values (`LEADS_DB_QP_KEY_VALUE`, `LEADS_DB_PAGE_LIMIT`, Axelor base URL, namespace) are assumed present in `.env` and out of scope for this PRD.

## 15. Suggested Implementation Slices (for SDD)

1. **Mapping bootstrap** — sampling script, SQLite schema, mapping CRUD (API + admin UI). *Revised in slice 1b after the Leads DB source model changed — see §16.*
2. **Migration engine core** — Leads DB client, sanitization, Axelor client (auth/session, create parent/child), sequential batch loop, checkpointing.
3. **Migration controls & error recovery** — start/pause/resume/stop, error log, manual retry.
4. **Admin front end** — login, dashboard, mapping editor, error review, controls wiring.

## 16. Revision History

- **2026-07-06**: The Leads DB source changed its data model. Previously, leads were fetched per `source_db`/`source_table` pair (75 combinations across ~30 "databases", including a `contact_*` family classified as person leads) via `/export?db=&table=&...`. The source now exposes a single `/companies` endpoint filtered by `country` (iterating the keys of `/dbs`'s `countries` object only — its `databases` object is obsolete), with fixed `has_phone=1&has_email=1` filters and pagination via `limit`/`offset` (page size from `LEADS_DB_PAGE_LIMIT`). Consequently: the Person domain (LinkedinSearch/LinkedinSearchResults) is dropped from scope entirely (no equivalent person-lead endpoint exists), and the original 832-row deduced field-mapping dataset (`references/leads-mapping/field-mappings.deduced.json`) was discarded and re-derived against the new endpoint's per-country samples. The already-implemented `mapping-bootstrap` slice (schema, CLI, seed, CRUD API) needed adjustment, not a rewrite — `field_mappings.source_db`/`source_table` were repurposed (country code / constant `"companies"`) rather than restructured, since the underlying uniqueness/admin-protection model still applies.
