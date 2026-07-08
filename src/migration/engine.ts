import type Database from "better-sqlite3";
import type { AxelorConfig } from "../config/env.js";
import type { LeadsClientConfig } from "../leads/leadsClient.js";
import { fetchCompaniesPage } from "../leads/leadsClient.js";
import type { AxelorSessionClient } from "../axelor/sessionClient.js";
import {
  createAiSearch,
  createAiSearchResults,
  getAiSearch,
  updateAiSearch,
  type AiSearchRecord,
} from "../axelor/restClient.js";
import { sanitizeRecord } from "../sanitize/sanitize.js";
import { buildAiSearchResultsPayload } from "./payloadBuilder.js";
import { listFieldMappings } from "../repos/mappingRepo.js";
import { createRun, getRunById, updateRunStatus, type MigrationRunStatus } from "../db/runsRepo.js";
import {
  upsertCheckpoint,
  advanceOffset,
  setAiSearchId,
  setStatus,
  type MigrationCheckpointStatus,
} from "../db/checkpointRepo.js";
import { recordError } from "../db/importErrorRepo.js";

/**
 * Injectable interruption check, polled between records (and between pages)
 * by the migration engine. The production implementation reads
 * `migration_runs.status` directly (a single indexed PK SELECT — negligible
 * next to the per-record Axelor HTTP round-trip), keeping the DB row as the
 * single source of truth and making pause/stop restart-durable. Tests inject
 * a fake to drive the halt deterministically without real control routes.
 */
export interface ControlSignal {
  state(runId: number): MigrationRunStatus;
}

function dbControlSignal(db: Database.Database): ControlSignal {
  return {
    state(runId: number): MigrationRunStatus {
      return getRunById(db, runId)?.status ?? "stopped";
    },
  };
}

export interface MigrationEngineDeps {
  readonly db: Database.Database;
  readonly leadsConfig: LeadsClientConfig;
  readonly axelorConfig: AxelorConfig;
  /** Page size requested from the Leads DB (`LEADS_DB_PAGE_LIMIT`). */
  readonly pageLimit: number;
  readonly session: AxelorSessionClient;
  /** Injectable fetch implementation for Axelor REST calls. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Country codes to process. Defaults to every country registered in `source_catalog`. */
  readonly countries?: readonly string[];
  /** An existing `migration_runs` id to resume. A new run is created when omitted. */
  readonly runId?: number;
  /** Injectable interruption check. Defaults to polling `migration_runs.status`. */
  readonly controlSignal?: ControlSignal;
}

export interface CountryMigrationSummary {
  readonly countryCode: string;
  readonly processedCount: number;
  readonly failedCount: number;
  readonly status: MigrationCheckpointStatus;
  /** True when this country's processing stopped early because the run was paused/stopped mid-page. */
  readonly halted: boolean;
}

export interface MigrationSummary {
  readonly runId: number;
  readonly countries: readonly CountryMigrationSummary[];
}

/** Source table name in the Leads DB — every country now exposes exactly one table. */
export const SOURCE_TABLE = "companies";

/** `AiSearch.statusSelect` codes, per `AXELOR_INTEGRATION.md`. */
export const AI_SEARCH_STATUS_IN_PROCESS = 1;
export const AI_SEARCH_STATUS_COMPLETED = 2;
export const AI_SEARCH_STATUS_NO_RESULTS = 3;

function getDefaultCountries(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT source_db FROM source_catalog ORDER BY source_db`)
    .all() as { source_db: string }[];
  return rows.map((row) => row.source_db);
}

/**
 * A network-level fetch failure (e.g. ECONNREFUSED, DNS failure, a rejected
 * TLS certificate) surfaces as a generic `TypeError: fetch failed` with the
 * actual root cause nested in `error.cause` — dropping it would make every
 * connectivity problem to Axelor or the Leads DB indistinguishable from any
 * other failure in `import_errors.error_reason`/the server log.
 */
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/**
 * Best-effort human-readable identifier for an import_errors row. Never the
 * raw record payload (per the migration-persistence spec) — just a single
 * recognizable field, when present, to help a human locate the failing row.
 */
export function deriveRecordIdentifier(record: Record<string, unknown>): string | null {
  const candidate = record["legal_name"] ?? record["name"] ?? record["id"];
  return typeof candidate === "string" ? candidate : null;
}

/**
 * Creates the `AiSearch` parent record for a country and persists its id onto
 * the checkpoint. Shared by the engine's per-country loop (lazy first-record
 * creation) and the single-record retry flow (`retry.ts`), which needs the
 * exact same on-the-spot creation when a country's checkpoint has no
 * `aiSearchId` yet (e.g. its only record so far failed before the parent was
 * ever created).
 */
export async function createAiSearchParent(
  db: Database.Database,
  session: AxelorSessionClient,
  axelorConfig: AxelorConfig,
  checkpointId: number,
  countryCode: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  const parent = await createAiSearch(
    session,
    axelorConfig,
    {
      statusSelect: 1,
      searchString: `Leads DB migration - ${countryCode}`,
      resultsNumber: 0,
    },
    fetchImpl,
  );
  setAiSearchId(db, checkpointId, parent.id);
  return parent.id;
}

/**
 * Shared GET-then-POST-with-one-retry skeleton behind `pushAiSearchProgress`
 * and `pushAiSearchResultAdded`: always re-reads the `AiSearch` parent's
 * current state via `getAiSearch` immediately before writing via
 * `updateAiSearch` (never a cached/reused `version` — see the callers' doc
 * comments for why), retries the whole sequence exactly once on any failure,
 * and swallows a second failure (logging it via `console.error`) rather than
 * throwing. `computeUpdate` derives the `statusSelect`/`resultsNumber` to
 * write from the freshly-read current record. Returns `true` on success,
 * `false` if both attempts failed — callers decide whether/how to surface
 * that failure (e.g. via `recordError`); this function itself never throws.
 */
async function pushAiSearchUpdate(
  session: AxelorSessionClient,
  axelorConfig: AxelorConfig,
  aiSearchId: number,
  fetchImpl: typeof fetch,
  computeUpdate: (current: AiSearchRecord) => { statusSelect: number; resultsNumber: number },
): Promise<boolean> {
  async function attempt(): Promise<void> {
    const current = await getAiSearch(session, axelorConfig, aiSearchId, fetchImpl);
    const { statusSelect, resultsNumber } = computeUpdate(current);
    await updateAiSearch(
      session,
      axelorConfig,
      { id: aiSearchId, version: current.version, statusSelect, resultsNumber },
      fetchImpl,
    );
  }

  try {
    await attempt();
    return true;
  } catch {
    try {
      await attempt();
      return true;
    } catch (error) {
      console.error(
        `pushAiSearchUpdate: failed to push AiSearch progress for aiSearchId=${aiSearchId} after one retry: ${errorMessage(error)}`,
      );
      return false;
    }
  }
}

export interface AiSearchProgressInput {
  readonly aiSearchId: number;
  /** Records newly saved since the last push — NOT a cumulative/running total. */
  readonly delta: number;
  /** True only for the country's last/exhausting page (source data exhausted). */
  readonly terminal: boolean;
}

/**
 * Pushes the `AiSearch` parent's progress (`statusSelect`/`resultsNumber`) to
 * Axelor as a DELTA on top of Axelor's own current `resultsNumber` — never an
 * absolute overwrite. Always re-reads the parent's CURRENT state via
 * `getAiSearch` immediately before writing — never cache/reuse a version (or
 * a running total) across calls, because both Axelor's optimistic-lock
 * `version` AND its `resultsNumber` on this record can be stale/advanced by
 * the time this runs (a concurrent retry from the Errors page, a prior
 * attempt of this same push, or a resumed run's in-memory counter starting
 * back at 0 must never clobber what Axelor already recorded). The new total
 * written is always `current.resultsNumber + input.delta`. `statusSelect` is
 * `IN_PROCESS` unless `input.terminal` is true, in which case it becomes
 * `COMPLETED` (new total > 0) or `NO_RESULTS` (new total is still 0).
 *
 * NON-FATAL CONTRACT: this is best-effort progress telemetry on Axelor's
 * side only. On any failure (from either the GET or the POST), the whole
 * GET-then-POST sequence is retried exactly once (with a fresh re-read). If
 * the second attempt also fails, the error is logged via `console.error`
 * (including `aiSearchId`) and this function returns `false` — it NEVER
 * throws. It must never block or fail the actual `AiSearchResults` child
 * writes, which are the real migrated data; callers are responsible for
 * surfacing a `false` return as a visible (but non-blocking) operator signal.
 */
export async function pushAiSearchProgress(
  session: AxelorSessionClient,
  axelorConfig: AxelorConfig,
  input: AiSearchProgressInput,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  return pushAiSearchUpdate(session, axelorConfig, input.aiSearchId, fetchImpl, (current) => {
    const newTotal = current.resultsNumber + input.delta;
    return {
      statusSelect: !input.terminal
        ? AI_SEARCH_STATUS_IN_PROCESS
        : newTotal > 0
          ? AI_SEARCH_STATUS_COMPLETED
          : AI_SEARCH_STATUS_NO_RESULTS,
      resultsNumber: newTotal,
    };
  });
}

/**
 * Pushes a single successful retry's progress to the `AiSearch` parent. Used
 * only by the single-record retry flow (`retry.ts`). A thin wrapper around
 * `pushAiSearchProgress` with `delta: 1, terminal: true` — a successful retry
 * always means exactly one more saved record than Axelor's last recorded
 * count, and a terminal push whose new total is always `>= 1` always resolves
 * to `COMPLETED` (a successful retry can never legitimately leave the parent
 * at `NO_RESULTS` anymore). Kept as a named export because the call site in
 * `retry.ts` reads more clearly with this name than inlining the input object
 * there.
 *
 * Same non-throwing, `boolean`-returning, best-effort contract as
 * `pushAiSearchProgress` — see its doc comment for the full rationale.
 */
export async function pushAiSearchResultAdded(
  session: AxelorSessionClient,
  axelorConfig: AxelorConfig,
  aiSearchId: number,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  return pushAiSearchProgress(session, axelorConfig, { aiSearchId, delta: 1, terminal: true }, fetchImpl);
}

interface CountryMigrationContext {
  readonly db: Database.Database;
  readonly leadsConfig: LeadsClientConfig;
  readonly axelorConfig: AxelorConfig;
  readonly pageLimit: number;
  readonly session: AxelorSessionClient;
  readonly fetchImpl: typeof fetch;
  readonly runId: number;
  readonly countryCode: string;
  readonly controlSignal: ControlSignal;
}

/**
 * Processes one country end to end: resumes from its persisted checkpoint
 * (reusing the AiSearch parent id if one already exists), then loops pages
 * until the Leads DB reports fewer rows than requested (exhaustion).
 *
 * The AiSearch parent is created lazily — only right before the first record
 * that actually needs it — so a country with zero data never triggers a
 * needless Axelor call. The checkpoint's `last_offset` advances once per
 * page, after every record in that page has been attempted (accepted
 * duplicate-risk decision — never per record).
 *
 * A per-record failure (Axelor rejects the create) is logged to
 * `import_errors` and processing continues with the next record. A failure
 * fetching the page itself (e.g. HTTP 500 from the Leads DB) is logged once
 * for the country (no record offset) and the country's checkpoint is marked
 * `failed`; the run continues with the next country.
 *
 * The `controlSignal` is polled at the top of the page loop and at the top
 * of the record loop (before starting each record). On a non-`running`
 * result, the loop halts immediately — finishing whichever record already
 * started is a no-op here because the poll happens *before* a record begins,
 * so the previous record has always already completed its write. The
 * in-flight page's offset is deliberately NOT advanced (`advanceOffset` is
 * skipped), so a resumed run re-fetches and re-processes that same page —
 * the same accepted duplicate-risk envelope as a mid-page crash.
 */
async function runCountryMigration(ctx: CountryMigrationContext): Promise<CountryMigrationSummary> {
  const { db, leadsConfig, axelorConfig, pageLimit, session, fetchImpl, runId, countryCode, controlSignal } =
    ctx;

  const checkpoint = upsertCheckpoint(db, runId, countryCode);
  const mappings = listFieldMappings(db, { sourceDb: countryCode, sourceTable: SOURCE_TABLE });

  let offset = checkpoint.lastOffset;
  let aiSearchId = checkpoint.aiSearchId;
  let processedCount = 0;
  let failedCount = 0;
  let finalStatus: MigrationCheckpointStatus = checkpoint.status;
  let halted = false;

  try {
    for (;;) {
      if (controlSignal.state(runId) !== "running") {
        halted = true;
        break;
      }

      const page = await fetchCompaniesPage(leadsConfig, countryCode, pageLimit, offset);
      let pagesSavedCount = 0;

      for (let index = 0; index < page.length; index += 1) {
        if (controlSignal.state(runId) !== "running") {
          halted = true;
          break;
        }

        const rawRecord = page[index]!;
        try {
          if (aiSearchId === null) {
            aiSearchId = await createAiSearchParent(
              db,
              session,
              axelorConfig,
              checkpoint.id,
              countryCode,
              fetchImpl,
            );
          }

          const sanitized = sanitizeRecord(rawRecord);
          const payload = buildAiSearchResultsPayload(sanitized, mappings, aiSearchId);
          await createAiSearchResults(session, axelorConfig, payload, fetchImpl);
          processedCount += 1;
          pagesSavedCount += 1;
        } catch (error) {
          failedCount += 1;
          recordError(db, {
            runId,
            countryCode,
            recordOffset: offset + index,
            recordIdentifier: deriveRecordIdentifier(rawRecord),
            errorReason: errorMessage(error),
          });
        }
      }

      if (halted) {
        break;
      }

      const isLastPage = page.length < pageLimit;
      // Skip the push when nothing changed and this isn't the terminal page —
      // there's nothing new to report, and it saves an Axelor round-trip on
      // pages where every record failed. The terminal COMPLETED/NO_RESULTS
      // status must still be pushed even with a zero delta.
      if (aiSearchId !== null && (pagesSavedCount > 0 || isLastPage)) {
        const pushSucceeded = await pushAiSearchProgress(
          session,
          axelorConfig,
          { aiSearchId, delta: pagesSavedCount, terminal: isLastPage },
          fetchImpl,
        );
        if (!pushSucceeded) {
          // Purely a visibility side-effect — must not affect finalStatus,
          // halted, or the loop's control flow. The migration keeps running.
          recordError(db, {
            runId,
            countryCode,
            recordOffset: null,
            recordIdentifier: null,
            errorReason: `AiSearch progress sync failed for aiSearchId=${aiSearchId}`,
          });
        }
      }

      advanceOffset(db, checkpoint.id, offset + page.length);

      if (isLastPage) {
        setStatus(db, checkpoint.id, "completed");
        finalStatus = "completed";
        break;
      }

      offset += page.length;
    }
  } catch (error) {
    recordError(db, {
      runId,
      countryCode,
      recordOffset: null,
      recordIdentifier: null,
      errorReason: errorMessage(error),
    });
    setStatus(db, checkpoint.id, "failed");
    finalStatus = "failed";
  }

  if (halted) {
    setStatus(db, checkpoint.id, "in_progress");
    finalStatus = "in_progress";
  }

  return { countryCode, processedCount, failedCount, status: finalStatus, halted };
}

/**
 * Runs (or resumes) a migration: sequentially, per country then per page,
 * sanitizes, maps, and creates each record in Axelor. See
 * `runCountryMigration` for the per-country resumption/failure contract.
 *
 * If any country halts early (control signal reports non-`running`), the
 * country loop stops immediately — remaining countries are left untouched
 * for a future resume — and the final `updateRunStatus(..., 'completed')` is
 * skipped so it never overwrites a status a control route already set
 * (`paused`/`stopped`) with `completed`.
 */
export async function runMigration(deps: MigrationEngineDeps): Promise<MigrationSummary> {
  const { db, leadsConfig, axelorConfig, pageLimit, session } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const runId = deps.runId ?? createRun(db).id;
  const countryCodes = deps.countries ?? getDefaultCountries(db);
  const controlSignal = deps.controlSignal ?? dbControlSignal(db);

  const countries: CountryMigrationSummary[] = [];
  let halted = false;
  for (const countryCode of countryCodes) {
    const summary = await runCountryMigration({
      db,
      leadsConfig,
      axelorConfig,
      pageLimit,
      session,
      fetchImpl,
      runId,
      countryCode,
      controlSignal,
    });
    countries.push(summary);

    if (summary.halted) {
      halted = true;
      break;
    }
  }

  if (!halted) {
    updateRunStatus(db, runId, "completed");
  }

  return { runId, countries };
}
