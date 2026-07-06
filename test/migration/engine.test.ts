import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { createRun } from "../../src/db/runsRepo.js";
import { getByRunCountry, upsertCheckpoint, advanceOffset, setAiSearchId } from "../../src/db/checkpointRepo.js";
import { runMigration, type MigrationEngineDeps } from "../../src/migration/engine.js";
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
});
