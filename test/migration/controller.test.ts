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
      expect(status.axelorBaseUrl).toBe("http://axelor.example.test");
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
      expect(status.axelorBaseUrl).toBe("http://axelor.example.test");
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

      const { rows, total } = controller.listErrors({ countryCode: "cl" });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.countryCode).toBe("cl");
      expect(total).toBe(1);
    });

    it("returns a total reflecting the FULL matching count even when rows is a smaller page", () => {
      const db = freshDb();
      const run = createRun(db);
      for (let i = 0; i < 5; i++) {
        recordError(db, {
          runId: run.id,
          countryCode: "ar",
          recordOffset: i,
          recordIdentifier: null,
          errorReason: `boom-${i}`,
        });
      }
      const controller = createMigrationController(db, fakeDeps(db));

      const { rows, total } = controller.listErrors({ runId: run.id, limit: 2, offset: 0 });

      expect(rows).toHaveLength(2);
      expect(total).toBe(5);
    });
  });

  describe("refreshCatalog", () => {
    it("delegates to runRefreshCatalog and returns its result", async () => {
      const db = freshDb();
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ countries: { AR: {}, CO: {} }, databases: {} }),
        text: async () => JSON.stringify({ countries: { AR: {}, CO: {} }, databases: {} }),
      });
      const deps: MigrationControllerDeps = {
        ...fakeDeps(db),
        leadsConfig: { ...fakeLeadsConfig(), fetchImpl: fetchImpl as unknown as typeof fetch },
      };
      const controller = createMigrationController(db, deps);

      const result = await controller.refreshCatalog();

      expect(result.totalCatalogEntries).toBe(2);
      expect(result.newPairs).toEqual([
        { sourceDb: "AR", sourceTable: "companies" },
        { sourceDb: "CO", sourceTable: "companies" },
      ]);
      const rows = db.prepare(`SELECT source_db FROM source_catalog ORDER BY source_db`).all();
      expect(rows).toEqual([{ source_db: "AR" }, { source_db: "CO" }]);
    });
  });

  describe("resetEverything", () => {
    it("delegates to runFullReset: wipes existing (non-active) runs and reseeds mappings/catalog", async () => {
      const db = freshDb();
      // Stopped, not active: an active run must be rejected (see the
      // "conflict" test below) — this test covers the ordinary success path.
      const run = createRun(db);
      updateRunStatus(db, run.id, "stopped");
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ countries: { AR: {}, CO: {} }, databases: {} }),
        text: async () => JSON.stringify({ countries: { AR: {}, CO: {} }, databases: {} }),
      });
      const deps: MigrationControllerDeps = {
        ...fakeDeps(db),
        leadsConfig: { ...fakeLeadsConfig(), fetchImpl: fetchImpl as unknown as typeof fetch },
      };
      const controller = createMigrationController(db, deps);

      const outcome = await controller.resetEverything();

      expect(outcome.outcome).toBe("ok");
      if (outcome.outcome === "ok") {
        expect(outcome.result.catalog.totalCatalogEntries).toBe(2);
      }
      expect(getActiveRun(db)).toBeNull();
      expect(getRunById(db, run.id)).toBeNull();
      const catalogRows = db.prepare(`SELECT source_db FROM source_catalog ORDER BY source_db`).all();
      expect(catalogRows).toEqual([{ source_db: "AR" }, { source_db: "CO" }]);
    });

    it("returns a conflict without wiping anything when a migration run is active", async () => {
      const db = freshDb();
      const run = createRun(db); // createRun defaults to status='running', i.e. active.
      seedTitleMapping(db, "AR");
      const fetchImpl = vi.fn();
      const deps: MigrationControllerDeps = {
        ...fakeDeps(db),
        leadsConfig: { ...fakeLeadsConfig(), fetchImpl: fetchImpl as unknown as typeof fetch },
      };
      const controller = createMigrationController(db, deps);

      const outcome = await controller.resetEverything();

      expect(outcome.outcome).toBe("conflict");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(getRunById(db, run.id)).not.toBeNull();
      const mappingsCount = (
        db.prepare(`SELECT COUNT(*) as count FROM field_mappings`).get() as { count: number }
      ).count;
      expect(mappingsCount).toBeGreaterThan(0);
    });

    it("rejects a concurrent resetEverything call while one is already in flight, without double-wiping", async () => {
      const db = freshDb();
      // Deferred gate: holds the first reset's catalog fetch open so a
      // second call can be issued while the first is still mid-flight,
      // forcing the race deterministically instead of relying on real
      // timing — mirrors the concurrent-retry test above.
      let releaseFetch: () => void = () => {};
      const fetchGate = new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      const fetchImpl = vi.fn().mockImplementation(async () => {
        await fetchGate;
        return {
          ok: true,
          status: 200,
          json: async () => ({ countries: { AR: {}, CO: {} }, databases: {} }),
          text: async () => JSON.stringify({ countries: { AR: {}, CO: {} }, databases: {} }),
        };
      });
      const deps: MigrationControllerDeps = {
        ...fakeDeps(db),
        leadsConfig: { ...fakeLeadsConfig(), fetchImpl: fetchImpl as unknown as typeof fetch },
      };
      const controller = createMigrationController(db, deps);

      const firstReset = controller.resetEverything();
      await flushMicrotasks();

      const secondOutcome = await controller.resetEverything();

      expect(secondOutcome.outcome).toBe("conflict");
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      releaseFetch();
      const firstOutcome = await firstReset;

      expect(firstOutcome.outcome).toBe("ok");
      if (firstOutcome.outcome === "ok") {
        expect(firstOutcome.result.catalog.totalCatalogEntries).toBe(2);
      }
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
      // Distinguishes the AiSearchResults create (PUT) from the AiSearch
      // progress push's GET-then-POST (triggered by `pushAiSearchResultAdded`
      // after a successful retry) so the call-count assertion below reflects
      // exactly one of each rather than three indistinguishable calls.
      const axelorFetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET" && url.endsWith(".AiSearch/999")) {
          return jsonResponse({
            status: 0,
            data: [{ id: 999, version: 1, statusSelect: 1, resultsNumber: 0 }],
          });
        }
        if (method === "POST" && url.endsWith(".AiSearch/999")) {
          return jsonResponse({
            status: 0,
            data: [{ id: 999, version: 2, statusSelect: 2, resultsNumber: 1 }],
          });
        }
        return jsonResponse({ status: 0, data: [{ id: 555 }] });
      });
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
      // 1 AiSearchResults create (PUT) + 1 AiSearch progress GET + 1 AiSearch
      // progress POST, from the `pushAiSearchResultAdded` call `retry.ts`
      // now makes after a successful save.
      expect(axelorFetchImpl).toHaveBeenCalledTimes(3);

      // The lock is released once the in-flight retry settles: a subsequent
      // retry for the same (now-resolved) errorId is no longer blocked by
      // the concurrency guard — it short-circuits on `already_resolved`.
      const thirdOutcome = await controller.retry(errorRow.id);
      expect(thirdOutcome.outcome).toBe("already_resolved");
    });
  });
});
