import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { createRun } from "../../src/db/runsRepo.js";
import { upsertCheckpoint, setAiSearchId, getByRunCountry } from "../../src/db/checkpointRepo.js";
import { recordError, getImportErrorById, markResolved } from "../../src/db/importErrorRepo.js";
import { retrySingleRecord, type RetrySingleRecordDeps } from "../../src/migration/retry.js";
import type { AxelorConfig } from "../../src/config/env.js";
import type { LeadsClientConfig } from "../../src/leads/leadsClient.js";
import type { AxelorSessionClient } from "../../src/axelor/sessionClient.js";

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

describe("retrySingleRecord", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns not_found for an unknown import_errors id", async () => {
    const db = freshDb();
    const leadsFetchImpl = vi.fn();
    const axelorFetchImpl = vi.fn();

    const deps: RetrySingleRecordDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };

    const result = await retrySingleRecord(deps, 999999);

    expect(result.outcome).toBe("not_found");
    expect(leadsFetchImpl).not.toHaveBeenCalled();
  });

  it("returns already_resolved without attempting a re-fetch", async () => {
    const db = freshDb();
    const run = createRun(db);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "AR",
      recordOffset: 5,
      recordIdentifier: "ACME",
      errorReason: "boom",
    });
    markResolved(db, error.id);

    const leadsFetchImpl = vi.fn();
    const axelorFetchImpl = vi.fn();

    const deps: RetrySingleRecordDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };

    const result = await retrySingleRecord(deps, error.id);

    expect(result.outcome).toBe("already_resolved");
    expect(leadsFetchImpl).not.toHaveBeenCalled();
  });

  it("re-fetches by offset, creates the record in Axelor, and marks the error resolved on success", async () => {
    const db = freshDb();
    seedTitleMapping(db, "AR");
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "AR");
    setAiSearchId(db, checkpoint.id, 999);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "AR",
      recordOffset: 40,
      recordIdentifier: "ACME",
      errorReason: "Axelor rejected: missing required field",
    });

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "ACME" })));
    const axelorFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 0, data: [{ id: 555 }] }));

    const deps: RetrySingleRecordDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };

    const result = await retrySingleRecord(deps, error.id);

    expect(result.outcome).toBe("resolved");
    const leadsUrl = leadsFetchImpl.mock.calls[0]?.[0] as string;
    expect(leadsUrl).toContain("offset=40");
    expect(leadsUrl).toContain("limit=1");
    expect(leadsUrl).toContain("country=AR");

    const [, init] = axelorFetchImpl.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as {
      data: { title?: string; aiSearch: { id: number } };
    };
    expect(sentBody.data.title).toBe("ACME");
    expect(sentBody.data.aiSearch).toEqual({ id: 999 });

    expect(getImportErrorById(db, error.id)?.resolved).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("pushes an AiSearch resultAdded update after a successful retry, with the correct aiSearchId", async () => {
    const db = freshDb();
    seedTitleMapping(db, "AR");
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "AR");
    setAiSearchId(db, checkpoint.id, 999);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "AR",
      recordOffset: 40,
      recordIdentifier: "ACME",
      errorReason: "Axelor rejected: missing required field",
    });

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "ACME" })));
    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith(".AiSearch/999")) {
        return jsonResponse({
          status: 0,
          data: [{ id: 999, version: 2, statusSelect: 1, resultsNumber: 5 }],
        });
      }
      if (method === "POST" && url.endsWith(".AiSearch/999")) {
        return jsonResponse({
          status: 0,
          data: [{ id: 999, version: 3, statusSelect: 2, resultsNumber: 6 }],
        });
      }
      return jsonResponse({ status: 0, data: [{ id: 555 }] });
    });

    const deps: RetrySingleRecordDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };

    const result = await retrySingleRecord(deps, error.id);

    expect(result.outcome).toBe("resolved");
    const postCall = axelorFetchImpl.mock.calls.find(
      (call: unknown[]) =>
        (call[1] as RequestInit)?.method === "POST" && (call[0] as string).endsWith(".AiSearch/999"),
    );
    expect(postCall).toBeDefined();
    const [, postInit] = postCall as [string, RequestInit];
    const sentBody = JSON.parse(postInit.body as string) as {
      data: { id: number; statusSelect: number; resultsNumber: number };
    };
    expect(sentBody.data).toMatchObject({ id: 999, statusSelect: 2, resultsNumber: 6 });
  });

  it("records a visibility-only import_errors row when the AiSearch progress push fails twice, without changing the resolved outcome", async () => {
    const db = freshDb();
    seedTitleMapping(db, "AR");
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "AR");
    setAiSearchId(db, checkpoint.id, 999);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "AR",
      recordOffset: 40,
      recordIdentifier: "ACME",
      errorReason: "Axelor rejected: missing required field",
    });

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "ACME" })));
    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string) => {
      // Both the GET and the retried GET inside pushAiSearchUpdate hit this
      // branch and fail, so the whole push fails twice.
      if (url.endsWith(".AiSearch/999")) {
        throw new Error("axelor unreachable");
      }
      return jsonResponse({ status: 0, data: [{ id: 555 }] });
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const deps: RetrySingleRecordDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };

    const result = await retrySingleRecord(deps, error.id);
    errorSpy.mockRestore();

    // The record itself saved successfully, so the retry must still resolve
    // — the push failure is an additional, non-blocking visibility signal.
    expect(result.outcome).toBe("resolved");
    expect(getImportErrorById(db, error.id)?.resolved).toBe(true);

    const visibilityErrors = db
      .prepare(`SELECT * FROM import_errors WHERE run_id = ? AND record_offset IS NULL`)
      .all(run.id) as { error_reason: string }[];
    expect(visibilityErrors).toHaveLength(1);
    expect(visibilityErrors[0]?.error_reason).toMatch(
      /AiSearch progress sync failed after a successful retry/,
    );
    expect(visibilityErrors[0]?.error_reason).toMatch(/aiSearchId=999/);
  });

  it("does not push an AiSearch resultAdded update when the retry itself fails", async () => {
    const db = freshDb();
    seedTitleMapping(db, "AR");
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "AR");
    setAiSearchId(db, checkpoint.id, 999);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "AR",
      recordOffset: 40,
      recordIdentifier: "ACME",
      errorReason: "Axelor rejected: missing required field",
    });

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "ACME" })));
    const axelorFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 1, data: [] }, true, 200));

    const deps: RetrySingleRecordDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };

    const result = await retrySingleRecord(deps, error.id);

    expect(result.outcome).toBe("failed");
    expect(axelorFetchImpl).toHaveBeenCalledTimes(1);
    const noAiSearchCall = axelorFetchImpl.mock.calls.some((call: unknown[]) =>
      (call[0] as string).endsWith(".AiSearch/999"),
    );
    expect(noAiSearchCall).toBe(false);
  });

  it("creates the AiSearch parent on the spot when the checkpoint has no aiSearchId yet, and persists it", async () => {
    const db = freshDb();
    seedTitleMapping(db, "BO");
    const run = createRun(db);
    // No checkpoint created yet for BO — retry must create it and the AiSearch parent.
    const error = recordError(db, {
      runId: run.id,
      countryCode: "BO",
      recordOffset: 3,
      recordIdentifier: "WIDGET CO",
      errorReason: "Axelor rejected: missing required field",
    });

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "WIDGET CO" })));
    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(".AiSearch")) {
        return jsonResponse({ status: 0, data: [{ id: 777 }] });
      }
      return jsonResponse({ status: 0, data: [{ id: 888 }] });
    });

    const deps: RetrySingleRecordDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };

    const result = await retrySingleRecord(deps, error.id);

    expect(result.outcome).toBe("resolved");
    const aiSearchCall = axelorFetchImpl.mock.calls.find((call: unknown[]) =>
      (call[0] as string).endsWith(".AiSearch"),
    );
    expect(aiSearchCall).toBeDefined();

    const checkpoint = getByRunCountry(db, run.id, "BO");
    expect(checkpoint?.aiSearchId).toBe(777);

    const [, resultsInit] = axelorFetchImpl.mock.calls[1] as [string, RequestInit];
    const sentBody = JSON.parse(resultsInit.body as string) as { data: { aiSearch: { id: number } } };
    expect(sentBody.data.aiSearch).toEqual({ id: 777 });
  });

  it("logs a warning but still completes the retry when the re-fetched record_identifier does not match", async () => {
    const db = freshDb();
    seedTitleMapping(db, "AR");
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "AR");
    setAiSearchId(db, checkpoint.id, 999);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "AR",
      recordOffset: 10,
      recordIdentifier: "OLD NAME LLC",
      errorReason: "boom",
    });

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "NEW NAME LLC" })));
    const axelorFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 0, data: [{ id: 1 }] }));

    const deps: RetrySingleRecordDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };

    const result = await retrySingleRecord(deps, error.id);

    expect(result.outcome).toBe("resolved");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/OLD NAME LLC/);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/NEW NAME LLC/);
  });

  it("records the new failure reason via updateErrorReason and leaves resolved=false when the Axelor create fails again", async () => {
    const db = freshDb();
    seedTitleMapping(db, "AR");
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "AR");
    setAiSearchId(db, checkpoint.id, 999);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "AR",
      recordOffset: 15,
      recordIdentifier: "ACME",
      errorReason: "first failure reason",
    });

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "ACME" })));
    const axelorFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 1, data: [] }, true, 200));

    const deps: RetrySingleRecordDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };

    const result = await retrySingleRecord(deps, error.id);

    expect(result.outcome).toBe("failed");
    const updated = getImportErrorById(db, error.id);
    expect(updated?.resolved).toBe(false);
    expect(updated?.errorReason).not.toBe("first failure reason");
    expect(updated?.errorReason).toMatch(/status 1/);
  });

  it("includes the underlying cause of a network-level fetch failure in the recorded reason", async () => {
    const db = freshDb();
    seedTitleMapping(db, "AR");
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "AR");
    setAiSearchId(db, checkpoint.id, 999);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "AR",
      recordOffset: 20,
      recordIdentifier: "ACME",
      errorReason: "boom",
    });

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "ACME" })));
    const axelorFetchImpl = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:443") }),
      );

    const deps: RetrySingleRecordDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };

    const result = await retrySingleRecord(deps, error.id);

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.reason).toMatch(/fetch failed/);
      expect(result.reason).toMatch(/ECONNREFUSED/);
    }
  });
});
