import type Database from "better-sqlite3";
import {
  createRun,
  getActiveRun,
  getMostRecentRun,
  updateRunStatus,
  type MigrationRunRow,
} from "../db/runsRepo.js";
import { listByRun, type MigrationCheckpointStatus } from "../db/checkpointRepo.js";
import {
  listImportErrors,
  countImportErrors,
  type ImportErrorFilter,
  type ImportErrorRow,
} from "../db/importErrorRepo.js";
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
 * `resetEverything()`'s outcome: unlike the passthrough it used to be, it can
 * no longer unconditionally succeed — an active migration run (or a
 * concurrent reset already in flight) must reject with `"conflict"` instead
 * of wiping `migration_runs`/`migration_checkpoints` out from under the
 * in-flight engine loop. Mirrors `ControlActionOutcome`'s shape/naming.
 */
export type ResetActionOutcome =
  | { readonly outcome: "ok"; readonly result: FullResetResult }
  | { readonly outcome: "conflict"; readonly message: string };

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
   * Rejects with `{ outcome: "retry_in_progress" }` when a retry for the
   * same `errorId` is already in flight (see `inFlightRetries` in the
   * factory below) — both HTTP surfaces call this same shared instance.
   */
  retry(errorId: number): Promise<RetryOutcome>;
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

  function launch(runId: number): void {
    const promise = runMigrationFn({ ...deps, runId });
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

      const checkpoints = listByRun(db, mostRecent.id).map((checkpoint) => ({
        countryCode: checkpoint.countryCode,
        lastOffset: checkpoint.lastOffset,
        status: checkpoint.status,
        aiSearchId: checkpoint.aiSearchId,
      }));
      const errors = countImportErrors(db, { runId: mostRecent.id });

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

    async retry(errorId: number): Promise<RetryOutcome> {
      if (inFlightRetries.has(errorId)) {
        return { outcome: "retry_in_progress" };
      }
      inFlightRetries.add(errorId);
      try {
        return await retrySingleRecord(deps, errorId);
      } finally {
        inFlightRetries.delete(errorId);
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
  };
}
