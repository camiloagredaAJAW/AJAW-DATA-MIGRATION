import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createRun, getActiveRun, updateRunStatus, type MigrationRunRow } from "../../db/runsRepo.js";
import { listByRun } from "../../db/checkpointRepo.js";
import { listImportErrors } from "../../db/importErrorRepo.js";
import { runMigration, type MigrationEngineDeps, type MigrationSummary } from "../../migration/engine.js";

/** Every engine dependency except the ones the routes derive per-call (`countries`, `runId`). */
export type MigrationControlDeps = Omit<MigrationEngineDeps, "countries" | "runId">;

export interface RegisterMigrationControlRoutesOptions {
  /** Injectable engine invocation, defaults to the real `runMigration`. Tests substitute a controllable fake. */
  readonly runMigrationFn?: (deps: MigrationEngineDeps) => Promise<MigrationSummary>;
}

function conflictError(message: string): { error: { code: string; message: string } } {
  return { error: { code: "conflict", message } };
}

function runSummary(run: MigrationRunRow): { runId: number; status: MigrationRunRow["status"] } {
  return { runId: run.id, status: run.status };
}

/**
 * Registers the migration lifecycle-control routes: start/pause/resume/stop
 * plus a status readout. Every route runs behind whatever auth hook the
 * caller registered on `fastify` beforehand (see `registerAuthGuard`).
 *
 * `/start` and `/resume` fire the engine WITHOUT awaiting it (respond 202
 * immediately) — `migration_runs.status` (not this function's registry) is
 * the single source of truth every route reads/writes, and is what the
 * engine's `ControlSignal` polls to halt cleanly (see `engine.ts`). The
 * closure-scoped `registry` here exists only to catch/log a fire-and-forget
 * rejection and clean up its own entry; it is never consulted by any route.
 */
export function registerMigrationControlRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
  deps: MigrationControlDeps,
  options: RegisterMigrationControlRoutesOptions = {},
): void {
  const runMigrationFn = options.runMigrationFn ?? runMigration;
  const registry = new Map<number, Promise<MigrationSummary>>();

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

  fastify.post("/api/migration/start", async (_request, reply) => {
    if (getActiveRun(db) !== null) {
      return reply.code(409).send(conflictError("A migration run is already running or paused"));
    }

    const run = createRun(db);
    launch(run.id);
    return reply.code(202).send({ data: runSummary(run) });
  });

  fastify.post("/api/migration/pause", async (_request, reply) => {
    const active = getActiveRun(db);
    if (active === null || active.status !== "running") {
      return reply.code(409).send(conflictError("No running migration run to pause"));
    }

    const updated = updateRunStatus(db, active.id, "paused") as MigrationRunRow;
    return reply.send({ data: runSummary(updated) });
  });

  fastify.post("/api/migration/resume", async (_request, reply) => {
    const active = getActiveRun(db);
    if (active === null || active.status !== "paused") {
      return reply.code(409).send(conflictError("No paused migration run to resume"));
    }

    const updated = updateRunStatus(db, active.id, "running") as MigrationRunRow;
    launch(updated.id);
    return reply.code(202).send({ data: runSummary(updated) });
  });

  fastify.post("/api/migration/stop", async (_request, reply) => {
    const active = getActiveRun(db);
    if (active === null) {
      return reply.code(409).send(conflictError("No active migration run to stop"));
    }

    const updated = updateRunStatus(db, active.id, "stopped") as MigrationRunRow;
    return reply.send({ data: runSummary(updated) });
  });

  fastify.get("/api/migration/status", async (_request, reply) => {
    const active = getActiveRun(db);
    if (active === null) {
      return reply.send({ data: { run: null, checkpoints: [], totals: { errors: 0 } } });
    }

    const checkpoints = listByRun(db, active.id).map((checkpoint) => ({
      countryCode: checkpoint.countryCode,
      lastOffset: checkpoint.lastOffset,
      status: checkpoint.status,
      aiSearchId: checkpoint.aiSearchId,
    }));
    const errors = listImportErrors(db, { runId: active.id }).length;

    return reply.send({
      data: {
        run: {
          id: active.id,
          status: active.status,
          startedAt: active.startedAt,
          updatedAt: active.updatedAt,
        },
        checkpoints,
        totals: { errors },
      },
    });
  });
}
