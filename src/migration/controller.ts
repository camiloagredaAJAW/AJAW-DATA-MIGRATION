import type Database from "better-sqlite3";
import {
  createRun,
  getActiveRun,
  getMostRecentRun,
  updateRunStatus,
  type MigrationRunRow,
} from "../db/runsRepo.js";
import {
  getMostRecentCheckpointForCountry,
  listLatestCheckpointsPerCountry,
  type MigrationCheckpointStatus,
} from "../db/checkpointRepo.js";
import {
  listImportErrors,
  countImportErrors,
  getErrorAnalytics as getErrorAnalyticsFromRepo,
  getErrorCountsByDay,
  type ImportErrorFilter,
  type ImportErrorRow,
  type ErrorAnalyticsBucket,
} from "../db/importErrorRepo.js";
import { getSavedCountsByDay } from "../db/dailySaveStatsRepo.js";
import {
  mergeDailyRecordCounts,
  bucketByIsoWeek,
  type DailyRecordCount,
} from "../analytics/dailyRecordStats.js";
import { retrySingleRecord, type RetryOutcome } from "./retry.js";
import { runMigration, type MigrationEngineDeps, type MigrationSummary } from "./engine.js";
import { runFullReset, runRefreshCatalog, type FullResetResult, type RefreshCatalogResult } from "../cli/bootstrap.js";

/** Every engine dependency except the ones the controller derives per-call (`countries`, `runId`). */
export type MigrationControllerDeps = Omit<MigrationEngineDeps, "countries" | "runId">;

export interface CreateMigrationControllerOptions {
  /** Injectable engine invocation, defaults to the real `runMigration`. Tests substitute a controllable fake. */
  readonly runMigrationFn?: (deps: MigrationEngineDeps) => Promise<MigrationSummary>;
}

export interface MigrationRunSummary {
  readonly runId: number;
  readonly status: MigrationRunRow["status"];
}

export type ControlActionOutcome =
  | { readonly outcome: "ok"; readonly run: MigrationRunSummary }
  | { readonly outcome: "conflict"; readonly message: string };

/**
 * `retryCountry()`'s outcome. `"not_found"` means the country has no
 * checkpoint history at all (`getMostRecentCheckpointForCountry` returns
 * null) — nothing to retry. `"conflict"` mirrors `ControlActionOutcome`'s
 * shape/naming for the same "another run/bulk-retry is active" reasons
 * `start()` already rejects on.
 */
export type RetryCountryOutcome =
  | { readonly outcome: "conflict"; readonly message: string }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "ok"; readonly run: MigrationRunSummary };

/**
 * `resetEverything()`'s outcome: unlike the passthrough it used to be, it can
 * no longer unconditionally succeed — an active migration run (or a
 * concurrent reset already in flight) must reject with `"conflict"` instead
 * of wiping `migration_runs`/`migration_checkpoints` out from under the
 * in-flight engine loop. Mirrors `ControlActionOutcome`'s shape/naming.
 */
export type ResetActionOutcome =
  | { readonly outcome: "ok"; readonly result: FullResetResult }
  | { readonly outcome: "conflict"; readonly message: string };

/** Same shape as the Errors page's filter, minus `resolved` — `retryErrorsBulk` always forces `resolved: false`. */
export interface BulkRetryFilter {
  readonly runId?: number;
  readonly countryCode?: string;
}

export interface BulkRetrySummary {
  /** TRUE total matching rows (uncapped), from `countImportErrors`. */
  readonly totalMatched: number;
  /** Rows actually attempted this call, capped at `BULK_RETRY_MAX_ROWS_PER_CALL`. */
  readonly processedCount: number;
  readonly resolvedCount: number;
  readonly failedCount: number;
  /**
   * Rows whose `performRetry` outcome was neither `"resolved"` nor `"failed"`
   * (`"already_resolved" | "not_found" | "retry_in_progress"`) — a real,
   * reachable race: a concurrent single-row `/admin/api/errors/:id/retry`
   * call can resolve a row between this sweep's snapshot and the loop
   * reaching it. Not a failed retry attempt, so it must not inflate
   * `failedCount`.
   */
  readonly skippedCount: number;
  readonly blockSize: number;
  readonly blockCount: number;
}

export type BulkRetryOutcome =
  | { readonly outcome: "conflict"; readonly message: string }
  | { readonly outcome: "completed"; readonly summary: BulkRetrySummary };

export interface MigrationStatusCheckpoint {
  readonly countryCode: string;
  readonly lastOffset: number;
  readonly status: MigrationCheckpointStatus;
  readonly aiSearchId: number | null;
}

export interface MigrationStatusPayload {
  readonly run: {
    readonly id: number;
    readonly status: MigrationRunRow["status"];
    readonly startedAt: string;
    readonly updatedAt: string;
  } | null;
  readonly checkpoints: readonly MigrationStatusCheckpoint[];
  readonly totals: { readonly errors: number };
  /** Static config, not run state — surfaced so the admin UI can show which Axelor instance is the write target. */
  readonly axelorBaseUrl: string;
}

export interface ListErrorsResult {
  readonly rows: ImportErrorRow[];
  readonly total: number;
}

export interface MigrationController {
  start(): ControlActionOutcome;
  pause(): ControlActionOutcome;
  resume(): ControlActionOutcome;
  stop(): ControlActionOutcome;
  status(): MigrationStatusPayload;
  listErrors(filter: ImportErrorFilter): ListErrorsResult;
  /**
   * Error breakdown by UTC day+hour. With no `day`, whole-table (unfiltered)
   * and percentage-of-whole-table. With `day` ("YYYY-MM-DD", UTC), scoped to
   * that single day and percentage-of-that-day's-total. See
   * `getErrorAnalytics` in importErrorRepo.ts.
   */
  getErrorAnalytics(day?: string): ErrorAnalyticsBucket[];
  /**
   * Saved-vs-error record counts bucketed by day or ISO week, most recent
   * `limit` buckets, ascending. "Saved" only reflects successful saves recorded
   * from `daily_save_stats` — see its migration for why there is no historical
   * backfill before that table existed.
   */
  getDailyRecordStats(granularity: "day" | "week", limit: number): DailyRecordCount[];
  /**
   * Rejects with `{ outcome: "retry_in_progress" }` when a retry for the
   * same `errorId` is already in flight (see `inFlightRetries` in the
   * factory below) — both HTTP surfaces call this same shared instance.
   */
  retry(errorId: number): Promise<RetryOutcome>;
  /**
   * Retries every currently-unresolved `import_errors` row matching `filter`
   * (`resolved` is always forced to `false` regardless of what `filter`
   * contains — the point of a bulk retry is to re-attempt rows that are
   * still failing), processed sequentially in blocks of
   * `BULK_RETRY_BLOCK_SIZE`, in one synchronous call that returns a summary
   * once every row has been attempted.
   *
   * Blocks with `{ outcome: "conflict" }` only when the active migration run
   * is `"running"` — a `"paused"` run does NOT block, since the intended
   * workflow is: pause the run, bulk-retry, then resume (bulk retry never
   * touches `migration_runs`/checkpoints, only `import_errors` + Axelor, so
   * resuming afterward is unaffected). This is a narrower check than
   * `start()`/`resetEverything()`'s `getActiveRun(db) !== null`, which blocks
   * on both `"running"` and `"paused"`.
   *
   * Also rejects with `{ outcome: "conflict" }` when another bulk retry is
   * already in flight (see `bulkRetryInProgress` in the factory below) — only
   * one may run process-wide at a time.
   */
  retryErrorsBulk(filter: BulkRetryFilter): Promise<BulkRetryOutcome>;
  /** Thin passthrough to `runRefreshCatalog` — see its doc comment for what it does. */
  refreshCatalog(): Promise<RefreshCatalogResult>;
  /**
   * Delegates to `runFullReset` — see its doc comment for what it does.
   * DESTRUCTIVE AND IRREVERSIBLE; the password re-check gating this lives in
   * `adminPlugin.ts`, not here, since this controller has no notion of HTTP
   * requests or credentials.
   *
   * Rejects with `{ outcome: "conflict" }` (WITHOUT wiping anything) when a
   * migration run is currently active (same `getActiveRun(db) !== null`
   * check `start()` uses) or when another reset is already in flight (see
   * `resetInFlight` in the factory below) — both HTTP surfaces call this same
   * shared instance.
   */
  resetEverything(): Promise<ResetActionOutcome>;
  /**
   * Retries JUST one country: creates a NEW `migration_runs` row scoped to
   * `[countryCode]` via `launch(run.id, [countryCode])`. Inside that run,
   * `upsertCheckpoint` (called by `runCountryMigration`) finds no existing
   * checkpoint for `(newRunId, countryCode)` and so seeds `last_offset`/
   * `ai_search_id` from `getMostRecentCheckpointForCountry` — i.e. this
   * correctly resumes the country from its last known state rather than
   * restarting it from offset 0, and never touches any other country.
   *
   * Synchronous, NOT awaited internally (mirrors `start()`/`resume()`, not
   * `retryErrorsBulk()`) — a country retry can take anywhere from seconds to
   * hours depending on how much of that country remains, so this must not
   * hold the call open. The admin watches progress via the dashboard's
   * existing status polling, exactly like `start()`/`resume()` already work.
   *
   * Rejects with `{ outcome: "not_found" }` when the country has no
   * checkpoint history at all — nothing to retry. Rejects with
   * `{ outcome: "conflict" }` when another run is already active
   * (`getActiveRun(db) !== null` — must be idle first, same precondition
   * philosophy as `start()`) or when a bulk retry is in flight.
   */
  retryCountry(countryCode: string): RetryCountryOutcome;
}

/**
 * Creates the shared migration-control state machine: start/pause/resume/stop,
 * a status readout, error listing, and single-record retry. Extracted out of
 * the `/api/migration/*` route handlers so both the `/api` and (later)
 * `/admin` HTTP surfaces drive the SAME instance — `migration_runs.status`
 * (not this function's registry) stays the single source of truth every
 * method reads/writes, and callers stay thin HTTP adapters over it.
 *
 * `/start` and `/resume` fire the engine WITHOUT awaiting it (the run
 * transitions synchronously; the engine keeps running in the background) —
 * the closure-scoped `registry` here exists only to catch/log a
 * fire-and-forget rejection and clean up its own entry; it is never consulted
 * by any method.
 */
export function createMigrationController(
  db: Database.Database,
  deps: MigrationControllerDeps,
  options: CreateMigrationControllerOptions = {},
): MigrationController {
  const runMigrationFn = options.runMigrationFn ?? runMigration;
  const registry = new Map<number, Promise<MigrationSummary>>();
  /**
   * Error ids with a `retry()` currently in flight. `retrySingleRecord` does
   * a check-then-act sequence (check `resolved`, fetch the record, lazily
   * create an `AiSearch` parent, create the `AiSearchResults` child, THEN
   * mark resolved) across multiple `await` points with no lock of its own.
   * Both the `/api` and `/admin` HTTP surfaces call into this SAME controller
   * instance, so guarding here — rather than inside `retrySingleRecord` — is
   * enough to stop two near-simultaneous retries for the same `errorId` from
   * both passing the `resolved === false` check and duplicating the Axelor
   * writes. Mirrors `registry`'s add-on-start/delete-in-`finally` shape above.
   */
  const inFlightRetries = new Set<number>();

  /**
   * True while a `resetEverything()` call is between its active-run check
   * and the completion of `runFullReset` (wipe + reseed). Only one process-
   * wide reset may run at a time: two near-simultaneous `POST
   * /admin/api/reset` calls (e.g. two browser tabs) would otherwise both
   * pass the `getActiveRun(db) === null` check and interleave their
   * wipe+reseed sequences. Mirrors `inFlightRetries`'
   * add-before-await/remove-in-`finally` shape, collapsed to a single
   * boolean since `resetEverything()` takes no id to key a `Set` by.
   */
  let resetInFlight = false;

  /** Block size `retryErrorsBulk` processes matching rows in, sequentially. */
  const BULK_RETRY_BLOCK_SIZE = 20;

  /**
   * Hard cap on rows processed by a single `retryErrorsBulk()` call. Each row
   * can involve 2-3 real network round-trips (Leads DB re-fetch, Axelor
   * create, AiSearch progress push), each with up to a ~60s timeout when a
   * dependency is degraded — with no cap, a filter matching hundreds/
   * thousands of unresolved rows would make this ONE synchronous HTTP call
   * run for a genuinely unbounded duration. This is a bounded-row-cap
   * mitigation, not a background-job redesign: the admin re-issues the same
   * call to continue past the cap (`totalMatched > processedCount` in the
   * summary signals there is more to do).
   */
  const BULK_RETRY_MAX_ROWS_PER_CALL = 200;

  /**
   * True while a `retryErrorsBulk()` call is in flight. Only one process-wide
   * bulk retry may run at a time — mirrors `resetInFlight`'s shape, collapsed
   * to a single boolean for the same reason (`retryErrorsBulk` takes a
   * filter, not an id, so there's nothing to key a `Set` by).
   */
  let bulkRetryInProgress = false;

  /**
   * Shared body of `retry()` and `retryErrorsBulk()`: the per-`errorId`
   * in-flight guard plus the delegation to `retrySingleRecord`. Extracted so
   * both call sites reuse the exact same concurrency guard and retry logic
   * with zero duplication.
   */
  async function performRetry(errorId: number): Promise<RetryOutcome> {
    if (inFlightRetries.has(errorId)) {
      return { outcome: "retry_in_progress" };
    }
    inFlightRetries.add(errorId);
    try {
      return await retrySingleRecord(deps, errorId);
    } finally {
      inFlightRetries.delete(errorId);
    }
  }

  function launch(runId: number, countries?: readonly string[]): void {
    const promise = runMigrationFn({ ...deps, runId, ...(countries !== undefined ? { countries } : {}) });
    registry.set(runId, promise);
    promise
      .catch((error: unknown) => {
        console.error(`migration run ${runId} failed`, error);
      })
      .finally(() => {
        registry.delete(runId);
      });
  }

  function summarize(run: MigrationRunRow): MigrationRunSummary {
    return { runId: run.id, status: run.status };
  }

  return {
    start(): ControlActionOutcome {
      if (bulkRetryInProgress) {
        return { outcome: "conflict", message: "Cannot start a migration run while a bulk retry is in progress" };
      }
      if (getActiveRun(db) !== null) {
        return { outcome: "conflict", message: "A migration run is already running or paused" };
      }

      const run = createRun(db);
      launch(run.id);
      return { outcome: "ok", run: summarize(run) };
    },

    pause(): ControlActionOutcome {
      const active = getActiveRun(db);
      if (active === null || active.status !== "running") {
        return { outcome: "conflict", message: "No running migration run to pause" };
      }

      const updated = updateRunStatus(db, active.id, "paused") as MigrationRunRow;
      return { outcome: "ok", run: summarize(updated) };
    },

    resume(): ControlActionOutcome {
      const active = getActiveRun(db);
      if (active === null || active.status !== "paused") {
        return { outcome: "conflict", message: "No paused migration run to resume" };
      }

      const updated = updateRunStatus(db, active.id, "running") as MigrationRunRow;
      launch(updated.id);
      return { outcome: "ok", run: summarize(updated) };
    },

    stop(): ControlActionOutcome {
      const active = getActiveRun(db);
      if (active === null) {
        return { outcome: "conflict", message: "No active migration run to stop" };
      }

      const updated = updateRunStatus(db, active.id, "stopped") as MigrationRunRow;
      return { outcome: "ok", run: summarize(updated) };
    },

    status(): MigrationStatusPayload {
      const mostRecent = getMostRecentRun(db);
      if (mostRecent === null) {
        return { run: null, checkpoints: [], totals: { errors: 0 }, axelorBaseUrl: deps.axelorConfig.baseUrl };
      }

      const checkpoints = listLatestCheckpointsPerCountry(db).map((checkpoint) => ({
        countryCode: checkpoint.countryCode,
        lastOffset: checkpoint.lastOffset,
        status: checkpoint.status,
        aiSearchId: checkpoint.aiSearchId,
      }));
      // Not scoped to `runId: mostRecent.id` — since checkpoints above now
      // span every run, not just the newest, the error total must match: a
      // small one-country retry run can become "most recent" while a big
      // multi-country run's errors are still unresolved and relevant.
      const errors = countImportErrors(db, { resolved: false });

      return {
        run: {
          id: mostRecent.id,
          status: mostRecent.status,
          startedAt: mostRecent.startedAt,
          updatedAt: mostRecent.updatedAt,
        },
        checkpoints,
        totals: { errors },
        axelorBaseUrl: deps.axelorConfig.baseUrl,
      };
    },

    listErrors(filter: ImportErrorFilter): ListErrorsResult {
      const { limit, offset, ...countFilter } = filter;
      return {
        rows: listImportErrors(db, filter),
        total: countImportErrors(db, countFilter),
      };
    },

    getErrorAnalytics(day?: string): ErrorAnalyticsBucket[] {
      return getErrorAnalyticsFromRepo(db, day);
    },

    getDailyRecordStats(granularity, limit) {
      // `[].slice(-limit)` returns the WHOLE array when `limit` is 0 (JS
      // quirk: `slice(-0) === slice(0)`) instead of nothing — guard explicitly
      // rather than relying on the zod schema at the HTTP boundary, since this
      // method is part of the public `MigrationController` interface.
      if (limit <= 0) {
        return [];
      }
      const daily = mergeDailyRecordCounts(getSavedCountsByDay(db), getErrorCountsByDay(db));
      const buckets = granularity === "week" ? bucketByIsoWeek(daily) : daily;
      return buckets.slice(-limit);
    },

    async retry(errorId: number): Promise<RetryOutcome> {
      return performRetry(errorId);
    },

    async retryErrorsBulk(filter: BulkRetryFilter): Promise<BulkRetryOutcome> {
      const active = getActiveRun(db);
      if (active !== null && active.status === "running") {
        return {
          outcome: "conflict",
          message: "Pause the active migration run before retrying errors in bulk",
        };
      }
      if (bulkRetryInProgress) {
        return { outcome: "conflict", message: "A bulk retry is already in progress" };
      }

      bulkRetryInProgress = true;
      try {
        const totalMatched = countImportErrors(db, { ...filter, resolved: false });
        const rows = listImportErrors(db, {
          ...filter,
          resolved: false,
          limit: BULK_RETRY_MAX_ROWS_PER_CALL,
        });
        let resolvedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        let blockCount = 0;
        for (let i = 0; i < rows.length; i += BULK_RETRY_BLOCK_SIZE) {
          const block = rows.slice(i, i + BULK_RETRY_BLOCK_SIZE);
          blockCount += 1;
          for (const row of block) {
            const outcome = await performRetry(row.id);
            if (outcome.outcome === "resolved") {
              resolvedCount += 1;
            } else if (outcome.outcome === "failed") {
              failedCount += 1;
            } else {
              skippedCount += 1;
            }
          }
        }
        return {
          outcome: "completed",
          summary: {
            totalMatched,
            processedCount: rows.length,
            resolvedCount,
            failedCount,
            skippedCount,
            blockSize: BULK_RETRY_BLOCK_SIZE,
            blockCount,
          },
        };
      } finally {
        bulkRetryInProgress = false;
      }
    },

    async refreshCatalog(): Promise<RefreshCatalogResult> {
      return runRefreshCatalog(db, deps.leadsConfig);
    },

    async resetEverything(): Promise<ResetActionOutcome> {
      if (resetInFlight) {
        return { outcome: "conflict", message: "A reset is already in progress" };
      }
      if (getActiveRun(db) !== null) {
        return { outcome: "conflict", message: "Cannot reset while a migration run is active" };
      }

      resetInFlight = true;
      try {
        const result = await runFullReset(db, deps.leadsConfig);
        return { outcome: "ok", result };
      } finally {
        resetInFlight = false;
      }
    },

    retryCountry(countryCode: string): RetryCountryOutcome {
      if (bulkRetryInProgress) {
        return { outcome: "conflict", message: "Cannot retry a country while a bulk retry is in progress" };
      }
      if (getActiveRun(db) !== null) {
        return { outcome: "conflict", message: "A migration run is already running or paused" };
      }

      const priorCheckpoint = getMostRecentCheckpointForCountry(db, countryCode);
      if (priorCheckpoint === null) {
        return { outcome: "not_found" };
      }

      const run = createRun(db);
      launch(run.id, [countryCode]);
      return { outcome: "ok", run: summarize(run) };
    },
  };
}
