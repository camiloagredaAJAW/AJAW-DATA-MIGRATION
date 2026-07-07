import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { createMigrationController, type MigrationControllerDeps } from "../../src/migration/controller.js";
import { createRun, getRunById, updateRunStatus, getActiveRun } from "../../src/db/runsRepo.js";
import { advanceOffset, upsertCheckpoint, setAiSearchId } from "../../src/db/checkpointRepo.js";
import { recordError, markResolved } from "../../src/db/importErrorRepo.js";
import type { AxelorConfig } from "../../src/config/env.js";
import type { LeadsClientConfig } from "../../src/leads/leadsClient.js";
import type { AxelorSessionClient } from "../../src/axelor/sessionClient.js";
import type { MigrationEngineDeps, MigrationSummary } from "../../src/migration/engine.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

function seedTitleMapping(db: Database.Database, countryCode: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO field_mappings
       (source_db, source_table, source_column, destination_domain, destination_field,
        additional_info_key, transform, confidence, note, origin, created_at, updated_at)
     VALUES (?, 'companies', 'legal_name', 'AiSearchResults', 'title', NULL, NULL, 'high', NULL, 'bootstrap', ?, ?)`,
  ).run(countryCode, now, now);
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(body || "{}"),
    text: async () => body,
  } as unknown as Response;
}

function fakeAxelorConfig(): AxelorConfig {
  return {
    baseUrl: "http://axelor.example.test",
    username: "admin",
    password: "secret",
    namespace: "com.ajaw",
    modelNameCompanies: "AiSearchResults",
  };
}

function fakeLeadsConfig(): LeadsClientConfig {
  return {
    baseUrl: "http://leads.example.test",
    dbsPath: "dbs",
    companiesPath: "companies",
    keyValue: "ajaw_live_2026",
  };
}

function fakeSession(): AxelorSessionClient {
  return {
    getSession: vi
      .fn()
      .mockResolvedValue({ authHeader: "Basic xyz", cookieHeader: "JSESSIONID=abc" }),
    invalidate: vi.fn(),
  };
}

function fakeDeps(db: Database.Database): MigrationControllerDeps {
  return {
    db,
    leadsConfig: fakeLeadsConfig(),
    axelorConfig: fakeAxelorConfig(),
    pageLimit: 100,
    session: fakeSession(),
  };
}

function resolvedRunMigrationFn(): (deps: MigrationEngineDeps) => Promise<MigrationSummary> {
  return async (deps) => ({ runId: deps.runId as number, countries: [] });
}

/** Lets any already-scheduled microtasks (fire-and-forget promise chains) settle before a test ends. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createMigrationController", () => {
  describe("start", () => {
    it("creates a new run and launches the engine when none is active", async () => {
      const db = freshDb();
      const controller = createMigrationController(db, fakeDeps(db), {
        runMigrationFn: resolvedRunMigrationFn(),
      });

      const result = controller.start();

      expect(result.outcome).toBe("ok");
      if (result.outcome === "ok") {
        expect(result.run.status).toBe("running");
        expect(getActiveRun(db)?.id).toBe(result.run.runId);
      }
      await flushMicrotasks();
    });

    it("returns a conflict when a run is already running or paused", () => {
      const db = freshDb();
      createRun(db);
      const controller = createMigrationController(db, fakeDeps(db), {
        runMigrationFn: resolvedRunMigrationFn(),
      });

      const result = controller.start();

      expect(result.outcome).toBe("conflict");
    });
  });

  describe("pause", () => {
    it("pauses a running run", () => {
      const db = freshDb();
      const run = createRun(db);
      const controller = createMigrationController(db, fakeDeps(db));

      const result = controller.pause();

      expect(result.outcome).toBe("ok");
      if (result.outcome === "ok") {
        expect(result.run.status).toBe("paused");
      }
      expect(getRunById(db, run.id)?.status).toBe("paused");
    });

    it("returns a conflict when no run is active", () => {
      const db = freshDb();
      const controller = createMigrationController(db, fakeDeps(db));

      const result = controller.pause();

      expect(result.outcome).toBe("conflict");
    });
  });

  describe("resume", () => {
    it("resumes a paused run and re-invokes the engine with the same runId", async () => {
      const db = freshDb();
      const run = createRun(db);
      updateRunStatus(db, run.id, "paused");
      const fn = vi.fn(resolvedRunMigrationFn());
      const controller = createMigrationController(db, fakeDeps(db), { runMigrationFn: fn });

      const result = controller.resume();

      expect(result.outcome).toBe("ok");
      if (result.outcome === "ok") {
        expect(result.run.status).toBe("running");
      }
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id }));
      await flushMicrotasks();
    });

    it("returns a conflict when no paused run exists", () => {
      const db = freshDb();
      const controller = createMigrationController(db, fakeDeps(db));

      const result = controller.resume();

      expect(result.outcome).toBe("conflict");
    });
  });

  describe("stop", () => {
    it("stops a running run", () => {
      const db = freshDb();
      const run = createRun(db);
      const controller = createMigrationController(db, fakeDeps(db));

      const result = controller.stop();

      expect(result.outcome).toBe("ok");
      expect(getRunById(db, run.id)?.status).toBe("stopped");
    });

    it("returns a conflict when no active run exists", () => {
      const db = freshDb();
      const controller = createMigrationController(db, fakeDeps(db));

      const result = controller.stop();

      expect(result.outcome).toBe("conflict");
    });
  });

  describe("status", () => {
    it("returns a null run when none has ever started", () => {
      const db = freshDb();
      const controller = createMigrationController(db, fakeDeps(db));

      const status = controller.status();

      expect(status.run).toBeNull();
      expect(status.checkpoints).toEqual([]);
      expect(status.totals.errors).toBe(0);
    });

    it("returns the most recent run's status, per-country checkpoints, and error count", () => {
      const db = freshDb();
      const run = createRun(db);
      const checkpoint = upsertCheckpoint(db, run.id, "ar");
      advanceOffset(db, checkpoint.id, 250);
      recordError(db, {
        runId: run.id,
        countryCode: "ar",
        recordOffset: 10,
        recordIdentifier: "ACME",
        errorReason: "boom",
      });
      const controller = createMigrationController(db, fakeDeps(db));

      const status = controller.status();

      expect(status.run?.id).toBe(run.id);
      expect(status.checkpoints).toHaveLength(1);
      expect(status.checkpoints[0]?.countryCode).toBe("ar");
      expect(status.checkpoints[0]?.lastOffset).toBe(250);
      expect(status.totals.errors).toBe(1);
    });
  });

  describe("listErrors", () => {
    it("filters by countryCode", () => {
      const db = freshDb();
      const run = createRun(db);
      recordError(db, {
        runId: run.id,
        countryCode: "ar",
        recordOffset: 10,
        recordIdentifier: "ACME",
        errorReason: "boom",
      });
      recordError(db, {
        runId: run.id,
        countryCode: "cl",
        recordOffset: 20,
        recordIdentifier: "OTHER",
        errorReason: "kaboom",
      });
      const controller = createMigrationController(db, fakeDeps(db));

      const rows = controller.listErrors({ countryCode: "cl" });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.countryCode).toBe("cl");
    });
  });

  describe("retry", () => {
    it("returns not_found for a nonexistent error id", async () => {
      const db = freshDb();
      const controller = createMigrationController(db, fakeDeps(db));

      const outcome = await controller.retry(999999);

      expect(outcome.outcome).toBe("not_found");
    });

    it("returns already_resolved without re-fetching when the error is already resolved", async () => {
      const db = freshDb();
      const run = createRun(db);
      const errorRow = recordError(db, {
        runId: run.id,
        countryCode: "ar",
        recordOffset: 10,
        recordIdentifier: "ACME",
        errorReason: "boom",
      });
      markResolved(db, errorRow.id);
      const controller = createMigrationController(db, fakeDeps(db));

      const outcome = await controller.retry(errorRow.id);

      expect(outcome.outcome).toBe("already_resolved");
    });

    it("resolves a failed record on successful retry, delegating to retrySingleRecord", async () => {
      const db = freshDb();
      seedTitleMapping(db, "AR");
      const run = createRun(db);
      const checkpoint = upsertCheckpoint(db, run.id, "AR");
      setAiSearchId(db, checkpoint.id, 999);
      const errorRow = recordError(db, {
        runId: run.id,
        countryCode: "AR",
        recordOffset: 5,
        recordIdentifier: "ACME",
        errorReason: "boom",
      });

      const leadsFetchImpl = vi.fn().mockResolvedValueOnce(textResponse(`{"legal_name":"ACME"}`));
      const axelorFetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ status: 0, data: [{ id: 555 }] }));
      const deps: MigrationControllerDeps = {
        db,
        leadsConfig: { ...fakeLeadsConfig(), fetchImpl: leadsFetchImpl as unknown as typeof fetch },
        axelorConfig: fakeAxelorConfig(),
        pageLimit: 100,
        session: fakeSession(),
        fetchImpl: axelorFetchImpl as unknown as typeof fetch,
      };
      const controller = createMigrationController(db, deps);

      const outcome = await controller.retry(errorRow.id);

      expect(outcome.outcome).toBe("resolved");
      if (outcome.outcome === "resolved") {
        expect(outcome.importError.resolved).toBe(true);
      }
    });

    it("rejects a concurrent retry for the same errorId while one is already in flight, without a duplicate Axelor write", async () => {
      const db = freshDb();
      seedTitleMapping(db, "AR");
      const run = createRun(db);
      const checkpoint = upsertCheckpoint(db, run.id, "AR");
      setAiSearchId(db, checkpoint.id, 999);
      const errorRow = recordError(db, {
        runId: run.id,
        countryCode: "AR",
        recordOffset: 5,
        recordIdentifier: "ACME",
        errorReason: "boom",
      });

      // Deferred gate: holds the first retry's leads re-fetch open so a
      // second retry for the SAME errorId can be issued while the first is
      // still mid-flight, forcing the race deterministically instead of
      // relying on real timing.
      let releaseLeadsFetch: () => void = () => {};
      const leadsGate = new Promise<void>((resolve) => {
        releaseLeadsFetch = resolve;
      });
      const leadsFetchImpl = vi.fn().mockImplementation(async () => {
        await leadsGate;
        return textResponse(`{"legal_name":"ACME"}`);
      });
      const axelorFetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse({ status: 0, data: [{ id: 555 }] }));
      const deps: MigrationControllerDeps = {
        db,
        leadsConfig: { ...fakeLeadsConfig(), fetchImpl: leadsFetchImpl as unknown as typeof fetch },
        axelorConfig: fakeAxelorConfig(),
        pageLimit: 100,
        session: fakeSession(),
        fetchImpl: axelorFetchImpl as unknown as typeof fetch,
      };
      const controller = createMigrationController(db, deps);

      const firstRetry = controller.retry(errorRow.id);
      await flushMicrotasks();

      const secondOutcome = await controller.retry(errorRow.id);

      expect(secondOutcome.outcome).toBe("retry_in_progress");
      expect(axelorFetchImpl).not.toHaveBeenCalled();

      releaseLeadsFetch();
      const firstOutcome = await firstRetry;

      expect(firstOutcome.outcome).toBe("resolved");
      expect(axelorFetchImpl).toHaveBeenCalledTimes(1);

      // The lock is released once the in-flight retry settles: a subsequent
      // retry for the same (now-resolved) errorId is no longer blocked by
      // the concurrency guard — it short-circuits on `already_resolved`.
      const thirdOutcome = await controller.retry(errorRow.id);
      expect(thirdOutcome.outcome).toBe("already_resolved");
    });
  });
});
