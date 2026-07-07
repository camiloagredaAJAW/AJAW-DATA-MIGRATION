import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { createRun, getRunById, updateRunStatus } from "../../src/db/runsRepo.js";
import { getByRunCountry, upsertCheckpoint, advanceOffset, setAiSearchId } from "../../src/db/checkpointRepo.js";
import { runMigration, type MigrationEngineDeps, type ControlSignal } from "../../src/migration/engine.js";
import type { MigrationRunStatus } from "../../src/db/runsRepo.js";
import type { AxelorConfig } from "../../src/config/env.js";
import type { LeadsClientConfig } from "../../src/leads/leadsClient.js";
import type { AxelorSessionClient } from "../../src/axelor/sessionClient.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

function seedCatalog(db: Database.Database, countryCodes: string[]): void {
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO source_catalog (source_db, source_table, last_sampled_at) VALUES (?, 'companies', ?)`,
  );
  for (const code of countryCodes) {
    insert.run(code, now);
  }
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

function axelorConfig(): AxelorConfig {
  return {
    baseUrl: "http://axelor.example.test",
    username: "admin",
    password: "secret",
    namespace: "com.ajaw",
    modelNameCompanies: "AiSearchResults",
  };
}

function leadsConfig(fetchImpl: typeof fetch): LeadsClientConfig {
  return {
    baseUrl: "http://leads.example.test",
    dbsPath: "dbs",
    companiesPath: "companies",
    keyValue: "ajaw_live_2026",
    fetchImpl,
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

function textResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => JSON.parse(body || "{}"),
    text: async () => body,
  } as unknown as Response;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function jsonLine(row: Record<string, unknown>): string {
  return JSON.stringify(row);
}

/**
 * A fake ControlSignal that reports 'running' for the first `pausedAfterCalls`
 * polls, then reports `haltStatus` forever after. The engine polls once at
 * the top of the page loop, then once per record — so callers can precisely
 * control which record boundary triggers the halt.
 */
function fakeControlSignal(pausedAfterCalls: number, haltStatus: MigrationRunStatus): ControlSignal {
  let calls = 0;
  return {
    state(): MigrationRunStatus {
      calls += 1;
      return calls > pausedAfterCalls ? haltStatus : "running";
    },
  };
}

describe("runMigration", () => {
  it("logs a per-record failure to import_errors and continues processing the rest of the page", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        textResponse(
          `${jsonLine({ legal_name: "ACME" })}\n${jsonLine({ legal_name: "OTHER" })}`,
        ),
      );

    let axelorCallCount = 0;
    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(".AiSearch")) {
        return jsonResponse({ status: 0, data: [{ id: 100 }] });
      }
      axelorCallCount += 1;
      if (axelorCallCount === 2) {
        return jsonResponse({ status: 1, data: [] }, true, 200);
      }
      return jsonResponse({ status: 0, data: [{ id: 200 + axelorCallCount }] });
    });

    const deps: MigrationEngineDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      pageLimit: 100,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
      countries: ["AR"],
    };

    const summary = await runMigration(deps);

    const countrySummary = summary.countries.find((c) => c.countryCode === "AR");
    expect(countrySummary?.processedCount).toBe(1);
    expect(countrySummary?.failedCount).toBe(1);
    expect(countrySummary?.status).toBe("completed");

    const errors = db.prepare(`SELECT * FROM import_errors WHERE country_code = 'AR'`).all() as {
      error_reason: string;
      record_offset: number;
    }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.record_offset).toBe(1);
    expect(errors[0]?.error_reason).toMatch(/status 1/);
  });

  it("skips a country whose page fetch fails (HTTP 500) but still processes the next country", async () => {
    const db = freshDb();
    seedCatalog(db, ["NI", "AR"]);
    seedTitleMapping(db, "AR");

    const leadsFetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("country=NI")) {
        return textResponse("", false, 500);
      }
      return textResponse(jsonLine({ legal_name: "ACME" }));
    });

    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(".AiSearch")) {
        return jsonResponse({ status: 0, data: [{ id: 1 }] });
      }
      return jsonResponse({ status: 0, data: [{ id: 2 }] });
    });

    const deps: MigrationEngineDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      pageLimit: 100,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
      countries: ["NI", "AR"],
    };

    const summary = await runMigration(deps);

    const niSummary = summary.countries.find((c) => c.countryCode === "NI");
    const arSummary = summary.countries.find((c) => c.countryCode === "AR");
    expect(niSummary?.status).toBe("failed");
    expect(arSummary?.status).toBe("completed");
    expect(arSummary?.processedCount).toBe(1);

    const niErrors = db.prepare(`SELECT * FROM import_errors WHERE country_code = 'NI'`).all() as {
      error_reason: string;
      record_offset: number | null;
    }[];
    expect(niErrors).toHaveLength(1);
    expect(niErrors[0]?.record_offset).toBeNull();
    expect(niErrors[0]?.error_reason).toMatch(/500/);
  });

  it("advances the checkpoint offset only after the entire page finishes, not per record", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        textResponse(
          `${jsonLine({ legal_name: "ACME" })}\n${jsonLine({ legal_name: "OTHER" })}`,
        ),
      )
      .mockResolvedValueOnce(textResponse(""));

    let axelorCallCount = 0;
    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(".AiSearch")) {
        return jsonResponse({ status: 0, data: [{ id: 1 }] });
      }
      axelorCallCount += 1;
      if (axelorCallCount === 1) {
        return jsonResponse({ status: 1, data: [] });
      }
      return jsonResponse({ status: 0, data: [{ id: 300 + axelorCallCount }] });
    });

    const db2runId = createRun(db).id;
    const deps: MigrationEngineDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      // Deliberately equal to the first page's row count: a page returning
      // exactly `pageLimit` rows must NOT be treated as exhaustion (it might
      // be a full page with more data behind it), forcing a follow-up fetch
      // that then confirms exhaustion via an empty page. With pageLimit=100
      // (as other tests use), a 2-row page is already `< limit` and would
      // exhaust immediately after one fetch — this test specifically exists
      // to prove the checkpoint offset used for that follow-up fetch reflects
      // the whole prior page, not a per-record increment.
      pageLimit: 2,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
      countries: ["AR"],
      runId: db2runId,
    };

    await runMigration(deps);

    const checkpoint = getByRunCountry(db, db2runId, "AR");
    expect(checkpoint?.lastOffset).toBe(2);
    expect(checkpoint?.status).toBe("completed");
    // The second (exhaustion) page fetch must request offset=2 — the full
    // prior page's row count — proving the checkpoint advanced once, for the
    // whole page, rather than incrementally after each record.
    const secondCallUrl = leadsFetchImpl.mock.calls[1]?.[0] as string;
    expect(secondCallUrl).toContain("offset=2");
  });

  it("resumes from a persisted checkpoint offset and reuses the existing AiSearch parent id", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "AR");
    advanceOffset(db, checkpoint.id, 50);
    setAiSearchId(db, checkpoint.id, 999);

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "ACME" })));

    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(".AiSearch")) {
        throw new Error("must not recreate the AiSearch parent when one is already persisted");
      }
      return jsonResponse({ status: 0, data: [{ id: 555 }] });
    });

    const deps: MigrationEngineDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      pageLimit: 100,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
      countries: ["AR"],
      runId: run.id,
    };

    const summary = await runMigration(deps);

    expect(summary.runId).toBe(run.id);
    const firstLeadsCallUrl = leadsFetchImpl.mock.calls[0]?.[0] as string;
    expect(firstLeadsCallUrl).toContain("offset=50");

    const [, init] = axelorFetchImpl.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { data: { aiSearch: { id: number } } };
    expect(sentBody.data.aiSearch).toEqual({ id: 999 });
  });

  it("defaults to every country registered in source_catalog when no explicit countries are provided", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR", "BO"]);
    seedTitleMapping(db, "AR");
    seedTitleMapping(db, "BO");

    const leadsFetchImpl = vi.fn().mockResolvedValue(textResponse(""));
    const axelorFetchImpl = vi.fn();

    const deps: MigrationEngineDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      pageLimit: 100,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };

    const summary = await runMigration(deps);

    expect(summary.countries.map((c) => c.countryCode).sort()).toEqual(["AR", "BO"]);
  });

  it("halts mid-page on a paused ControlSignal: finishes the in-flight record, does not start the next, and leaves the checkpoint offset unchanged", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        textResponse(
          `${jsonLine({ legal_name: "ACME" })}\n${jsonLine({ legal_name: "OTHER" })}`,
        ),
      );

    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(".AiSearch")) {
        return jsonResponse({ status: 0, data: [{ id: 100 }] });
      }
      return jsonResponse({ status: 0, data: [{ id: 200 }] });
    });

    const run = createRun(db);
    // Polls: 1) top of page loop, 2) before record 0, 3) before record 1.
    // Report 'running' for the first two polls (page loop + record 0), then
    // 'paused' — so record 0 finishes but record 1 never starts.
    const controlSignal = fakeControlSignal(2, "paused");

    const deps: MigrationEngineDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      pageLimit: 100,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
      countries: ["AR"],
      runId: run.id,
      controlSignal,
    };

    const summary = await runMigration(deps);

    const countrySummary = summary.countries.find((c) => c.countryCode === "AR");
    expect(countrySummary?.processedCount).toBe(1);
    expect(countrySummary?.halted).toBe(true);

    const checkpoint = getByRunCountry(db, run.id, "AR");
    expect(checkpoint?.lastOffset).toBe(0);
    expect(checkpoint?.status).not.toBe("completed");
    expect(checkpoint?.status).not.toBe("failed");
  });

  it("does not overwrite migration_runs.status to 'completed' when the run was halted (paused/stopped)", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        textResponse(
          `${jsonLine({ legal_name: "ACME" })}\n${jsonLine({ legal_name: "OTHER" })}`,
        ),
      );

    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(".AiSearch")) {
        return jsonResponse({ status: 0, data: [{ id: 100 }] });
      }
      return jsonResponse({ status: 0, data: [{ id: 200 }] });
    });

    const run = createRun(db);
    // Simulates the /pause route already having flipped the DB status before
    // the engine notices via its next poll.
    updateRunStatus(db, run.id, "paused");
    const controlSignal = fakeControlSignal(0, "paused");

    const deps: MigrationEngineDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      pageLimit: 100,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
      countries: ["AR"],
      runId: run.id,
      controlSignal,
    };

    await runMigration(deps);

    expect(getRunById(db, run.id)?.status).toBe("paused");
  });

  it("carries forward a country's checkpoint offset and AiSearch parent id into a BRAND-NEW run (e.g. /start after /stop), instead of restarting the country from 0", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    // Run A processed AR up through offset 500 and persisted an AiSearch
    // parent id, then was stopped (checkpoint left as-is, per spec: stop
    // does not touch checkpoints).
    const runA = createRun(db);
    const checkpointA = upsertCheckpoint(db, runA.id, "AR");
    advanceOffset(db, checkpointA.id, 500);
    setAiSearchId(db, checkpointA.id, 999);
    updateRunStatus(db, runA.id, "stopped");

    // Run B is a DIFFERENT run_id — simulating a fresh POST /start after the
    // stop. No checkpoint exists yet for (runB.id, "AR"): the engine must
    // seed it from run A's checkpoint rather than defaulting to offset 0.
    const runB = createRun(db);

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "ACME" })));

    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(".AiSearch")) {
        throw new Error("must not recreate the AiSearch parent — a prior run's id must be reused");
      }
      return jsonResponse({ status: 0, data: [{ id: 555 }] });
    });

    const deps: MigrationEngineDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      pageLimit: 100,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
      countries: ["AR"],
      runId: runB.id,
    };

    await runMigration(deps);

    // The Leads DB fetch for the new run must start at the carried-forward
    // offset (500), not 0.
    const firstLeadsCallUrl = leadsFetchImpl.mock.calls[0]?.[0] as string;
    expect(firstLeadsCallUrl).toContain("offset=500");

    // The new run's own checkpoint row was seeded from run A's (500 + the
    // single-record page it just processed = 501), not created fresh at
    // 0/null (which would have left it at 1).
    const checkpointB = getByRunCountry(db, runB.id, "AR");
    expect(checkpointB?.lastOffset).toBe(501);
    expect(checkpointB?.aiSearchId).toBe(999);

    // Run A's own checkpoint is untouched by run B's processing.
    const reloadedCheckpointA = getByRunCountry(db, runA.id, "AR");
    expect(reloadedCheckpointA?.lastOffset).toBe(500);
  });
});
