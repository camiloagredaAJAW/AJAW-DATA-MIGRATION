import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { createRun, getRunById, updateRunStatus } from "../../src/db/runsRepo.js";
import { getByRunCountry, upsertCheckpoint, advanceOffset, setAiSearchId } from "../../src/db/checkpointRepo.js";
import { listFieldMappings } from "../../src/repos/mappingRepo.js";
import {
  runMigration,
  pushAiSearchProgress,
  pushAiSearchResultAdded,
  AI_SEARCH_STATUS_IN_PROCESS,
  AI_SEARCH_STATUS_COMPLETED,
  AI_SEARCH_STATUS_NO_RESULTS,
  type MigrationEngineDeps,
  type ControlSignal,
} from "../../src/migration/engine.js";
import type { MigrationRunStatus } from "../../src/db/runsRepo.js";
import type { AxelorConfig } from "../../src/config/env.js";
import type { LeadsClientConfig } from "../../src/leads/leadsClient.js";
import type { AxelorSessionClient } from "../../src/axelor/sessionClient.js";
import { incrementSavedCount, getSavedCountsByDay } from "../../src/db/dailySaveStatsRepo.js";

// `listFieldMappings` is a hard, non-injectable import inside
// `runCountryMigration` (not part of `MigrationEngineDeps`) — this is the
// only seam available to make it throw for the Fix 1 regression test below
// (a checkpoint must never get stuck at 'running' when something in the
// pre-loop setup gap throws). `vi.fn(actual.listFieldMappings)` wraps the
// real implementation by default so every OTHER test in this file (which
// never touches this mock) keeps exercising the genuine DB-backed behavior;
// only the one test that opts in via `mockImplementationOnce` sees a throw.
vi.mock("../../src/repos/mappingRepo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repos/mappingRepo.js")>();
  return {
    ...actual,
    listFieldMappings: vi.fn(actual.listFieldMappings),
  };
});

// Same wrapping approach as `listFieldMappings` above — the only seam
// available to make `incrementSavedCount` throw for the Fix 1 regression
// test below (a telemetry-write failure must never be misread as a failed
// record save). Wraps the real implementation by default so every other
// test keeps exercising genuine DB-backed behavior.
vi.mock("../../src/db/dailySaveStatsRepo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/dailySaveStatsRepo.js")>();
  return {
    ...actual,
    incrementSavedCount: vi.fn(actual.incrementSavedCount),
  };
});

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

/**
 * A fake Axelor fetch that handles the full surface `runCountryMigration`
 * touches: `PUT .AiSearch` (parent create), `GET`/`POST .AiSearch/:id`
 * (progress push), and anything else (`AiSearchResults` create). Every
 * `POST .AiSearch/:id` body is recorded in `pushCalls` for assertions.
 *
 * Stateful across calls: a `GET .AiSearch/:id` always returns whatever the
 * most recent `POST .AiSearch/:id` last wrote (starting from
 * `options.initialResultsNumber`, default 0) — mirroring how the real Axelor
 * parent record persists between pushes, which the delta-based
 * `pushAiSearchProgress` depends on to compute the next total correctly.
 */
function trackingAxelorFetch(
  aiSearchId: number,
  options: { resultsShouldFail?: boolean; initialResultsNumber?: number } = {},
): {
  fetchImpl: ReturnType<typeof vi.fn>;
  pushCalls: Array<{ id: number; version: number; statusSelect: number; resultsNumber: number }>;
} {
  const pushCalls: Array<{ id: number; version: number; statusSelect: number; resultsNumber: number }> =
    [];
  let currentVersion = 0;
  let currentStatusSelect = AI_SEARCH_STATUS_IN_PROCESS;
  let currentResultsNumber = options.initialResultsNumber ?? 0;
  const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "PUT" && url.endsWith(".AiSearch")) {
      return jsonResponse({ status: 0, data: [{ id: aiSearchId }] });
    }
    if (method === "GET" && url.endsWith(`.AiSearch/${aiSearchId}`)) {
      return jsonResponse({
        status: 0,
        data: [
          {
            id: aiSearchId,
            version: currentVersion,
            statusSelect: currentStatusSelect,
            resultsNumber: currentResultsNumber,
          },
        ],
      });
    }
    if (method === "POST" && url.endsWith(`.AiSearch/${aiSearchId}`)) {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        data: { id: number; version: number; statusSelect: number; resultsNumber: number };
      };
      pushCalls.push(body.data);
      currentVersion += 1;
      currentStatusSelect = body.data.statusSelect;
      currentResultsNumber = body.data.resultsNumber;
      return jsonResponse({
        status: 0,
        data: [
          {
            id: aiSearchId,
            version: currentVersion,
            statusSelect: currentStatusSelect,
            resultsNumber: currentResultsNumber,
          },
        ],
      });
    }
    if (options.resultsShouldFail) {
      return jsonResponse({ status: 1, data: [] });
    }
    return jsonResponse({ status: 0, data: [{ id: 999 }] });
  });
  return { fetchImpl, pushCalls };
}

describe("pushAiSearchProgress", () => {
  it("re-reads the current resultsNumber via GET and sends back current+delta via POST (never an absolute overwrite)", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return jsonResponse({
          status: 0,
          data: [{ id: 42, version: 5, statusSelect: 1, resultsNumber: 3 }],
        });
      }
      return jsonResponse({
        status: 0,
        data: [{ id: 42, version: 6, statusSelect: 2, resultsNumber: 10 }],
      });
    });
    const session = fakeSession();

    const result = await pushAiSearchProgress(
      session,
      axelorConfig(),
      { aiSearchId: 42, delta: 7, terminal: true },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, postInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    // current (3) + delta (7) = 10, terminal with a positive total -> COMPLETED.
    expect(JSON.parse(postInit.body as string)).toEqual({
      data: { id: 42, version: 5, statusSelect: AI_SEARCH_STATUS_COMPLETED, resultsNumber: 10 },
    });
  });

  it("uses IN_PROCESS (never COMPLETED/NO_RESULTS) when terminal is false, regardless of the resulting total", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return jsonResponse({
          status: 0,
          data: [{ id: 42, version: 5, statusSelect: 1, resultsNumber: 3 }],
        });
      }
      return jsonResponse({
        status: 0,
        data: [{ id: 42, version: 6, statusSelect: 1, resultsNumber: 3 }],
      });
    });
    const session = fakeSession();

    await pushAiSearchProgress(
      session,
      axelorConfig(),
      { aiSearchId: 42, delta: 0, terminal: false },
      fetchImpl as unknown as typeof fetch,
    );

    const [, postInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(postInit.body as string)).toEqual({
      data: { id: 42, version: 5, statusSelect: AI_SEARCH_STATUS_IN_PROCESS, resultsNumber: 3 },
    });
  });

  it("retries the whole GET-then-POST sequence once when the GET fails", async () => {
    let getCallCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        getCallCount += 1;
        if (getCallCount === 1) {
          throw new Error("network down");
        }
        return jsonResponse({
          status: 0,
          data: [{ id: 42, version: 5, statusSelect: 1, resultsNumber: 3 }],
        });
      }
      return jsonResponse({
        status: 0,
        data: [{ id: 42, version: 6, statusSelect: 2, resultsNumber: 10 }],
      });
    });
    const session = fakeSession();

    await expect(
      pushAiSearchProgress(
        session,
        axelorConfig(),
        { aiSearchId: 42, delta: 7, terminal: true },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBe(true);

    // 1st attempt: GET fails (1 call). 2nd attempt: GET + POST succeed (2 calls).
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries the whole GET-then-POST sequence once when the POST fails", async () => {
    let postCallCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return jsonResponse({
          status: 0,
          data: [{ id: 42, version: 5, statusSelect: 1, resultsNumber: 3 }],
        });
      }
      postCallCount += 1;
      if (postCallCount === 1) {
        throw new Error("axelor down");
      }
      return jsonResponse({
        status: 0,
        data: [{ id: 42, version: 6, statusSelect: 2, resultsNumber: 10 }],
      });
    });
    const session = fakeSession();

    const result = await pushAiSearchProgress(
      session,
      axelorConfig(),
      { aiSearchId: 42, delta: 7, terminal: true },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toBe(true);
    // 1st attempt: GET + POST(fail) (2 calls). 2nd attempt: GET + POST(success) (2 calls).
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("returns false and logs via console.error (with aiSearchId) when both attempts fail, without throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("axelor unreachable"));
    const session = fakeSession();

    await expect(
      pushAiSearchProgress(
        session,
        axelorConfig(),
        { aiSearchId: 42, delta: 7, terminal: true },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.join(" ")).toMatch(/42/);

    errorSpy.mockRestore();
  });
});

describe("pushAiSearchResultAdded", () => {
  it("reads the current resultsNumber, sends current+1, and forces statusSelect to COMPLETED", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return jsonResponse({
          status: 0,
          data: [{ id: 42, version: 5, statusSelect: 1, resultsNumber: 3 }],
        });
      }
      return jsonResponse({
        status: 0,
        data: [{ id: 42, version: 6, statusSelect: 2, resultsNumber: 4 }],
      });
    });
    const session = fakeSession();

    await pushAiSearchResultAdded(session, axelorConfig(), 42, fetchImpl as unknown as typeof fetch);

    const [, postInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(postInit.body as string)).toEqual({
      data: { id: 42, version: 5, statusSelect: AI_SEARCH_STATUS_COMPLETED, resultsNumber: 4 },
    });
  });

  it("returns false and logs via console.error when both attempts fail, without throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("axelor unreachable"));
    const session = fakeSession();

    await expect(
      pushAiSearchResultAdded(session, axelorConfig(), 42, fetchImpl as unknown as typeof fetch),
    ).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

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
    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT" && url.endsWith(".AiSearch")) {
        return jsonResponse({ status: 0, data: [{ id: 100 }] });
      }
      // AiSearch progress push (after the page finishes) — kept well-formed
      // and separate from the record-creation counting below, so this
      // test's per-record success/failure sequencing is unaffected by it.
      if (method === "GET" && url.endsWith(".AiSearch/100")) {
        return jsonResponse({
          status: 0,
          data: [{ id: 100, version: 0, statusSelect: AI_SEARCH_STATUS_IN_PROCESS, resultsNumber: 0 }],
        });
      }
      if (method === "POST" && url.endsWith(".AiSearch/100")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          data: { statusSelect: number; resultsNumber: number };
        };
        return jsonResponse({
          status: 0,
          data: [
            {
              id: 100,
              version: 1,
              statusSelect: body.data.statusSelect,
              resultsNumber: body.data.resultsNumber,
            },
          ],
        });
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

    // AR's AiSearch parent (id=999) already had 500 results recorded in
    // Axelor BEFORE this resume — simulating a Pause/Resume (or Stop/new
    // run) where the engine's in-memory processedCount restarts at 0 but
    // Axelor's own resultsNumber does not. This is the direct regression
    // test for the delta-based redesign: the resumed run's single newly
    // processed record must be ADDED to that pre-existing 500, never
    // overwrite it (the pre-fix bug would have pushed resultsNumber=1).
    const preExistingResultsNumber = 500;
    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT" && url.endsWith(".AiSearch")) {
        throw new Error("must not recreate the AiSearch parent when one is already persisted");
      }
      if (method === "GET" && url.endsWith(".AiSearch/999")) {
        return jsonResponse({
          status: 0,
          data: [
            { id: 999, version: 0, statusSelect: AI_SEARCH_STATUS_IN_PROCESS, resultsNumber: preExistingResultsNumber },
          ],
        });
      }
      if (method === "POST" && url.endsWith(".AiSearch/999")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          data: { id: number; version: number; statusSelect: number; resultsNumber: number };
        };
        return jsonResponse({
          status: 0,
          data: [
            {
              id: 999,
              version: 1,
              statusSelect: body.data.statusSelect,
              resultsNumber: body.data.resultsNumber,
            },
          ],
        });
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

    // The regression assertion: the push after resume must compute
    // 500 (pre-existing) + 1 (this resume's single processed record) = 501,
    // never a bare 1 (an absolute overwrite of the in-memory counter).
    const pushCall = axelorFetchImpl.mock.calls.find(
      (call) =>
        (call[1] as RequestInit | undefined)?.method === "POST" &&
        (call[0] as string).endsWith(".AiSearch/999"),
    );
    expect(pushCall).toBeDefined();
    const [, pushInit] = pushCall as [string, RequestInit];
    const pushBody = JSON.parse(pushInit.body as string) as {
      data: { resultsNumber: number; statusSelect: number };
    };
    expect(pushBody.data.resultsNumber).toBe(preExistingResultsNumber + 1);
    expect(pushBody.data.statusSelect).toBe(AI_SEARCH_STATUS_COMPLETED);
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
    expect(checkpoint?.status).toBe("halted");
  });

  it("sets the checkpoint status to 'running' before the country's first page is fetched, ahead of its terminal status", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    const run = createRun(db);
    let statusDuringFirstFetch: string | undefined;
    const leadsFetchImpl = vi.fn().mockImplementation(async () => {
      const checkpoint = getByRunCountry(db, run.id, "AR");
      statusDuringFirstFetch = checkpoint?.status;
      return textResponse(jsonLine({ legal_name: "ACME" }));
    });

    const { fetchImpl: axelorFetchImpl } = trackingAxelorFetch(100);

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

    expect(statusDuringFirstFetch).toBe("running");

    const countrySummary = summary.countries.find((c) => c.countryCode === "AR");
    expect(countrySummary?.status).toBe("completed");
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

  it("pushes IN_PROCESS after a mid-country page and COMPLETED with the final count on the exhausting page", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        textResponse(`${jsonLine({ legal_name: "A" })}\n${jsonLine({ legal_name: "B" })}`),
      )
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "C" })));

    const { fetchImpl: axelorFetchImpl, pushCalls } = trackingAxelorFetch(500);

    const deps: MigrationEngineDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      pageLimit: 2,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
      countries: ["AR"],
    };

    await runMigration(deps);

    expect(pushCalls).toHaveLength(2);
    expect(pushCalls[0]).toMatchObject({ statusSelect: AI_SEARCH_STATUS_IN_PROCESS, resultsNumber: 2 });
    expect(pushCalls[1]).toMatchObject({ statusSelect: AI_SEARCH_STATUS_COMPLETED, resultsNumber: 3 });
  });

  it("pushes NO_RESULTS when a country's page(s) exhaust with zero successfully processed records", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "A" })));

    const { fetchImpl: axelorFetchImpl, pushCalls } = trackingAxelorFetch(600, {
      resultsShouldFail: true,
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

    expect(summary.countries[0]?.processedCount).toBe(0);
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toMatchObject({ statusSelect: AI_SEARCH_STATUS_NO_RESULTS, resultsNumber: 0 });
  });

  it("does not push AiSearch progress when the loop halts mid-page (pause/stop)", async () => {
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

    const { fetchImpl: axelorFetchImpl, pushCalls } = trackingAxelorFetch(700);

    const run = createRun(db);
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

    await runMigration(deps);

    expect(pushCalls).toHaveLength(0);
  });

  it("does not push AiSearch progress on the outer-catch failure path (Leads DB fetch throws)", async () => {
    const db = freshDb();
    seedCatalog(db, ["NI"]);

    const leadsFetchImpl = vi.fn().mockResolvedValueOnce(textResponse("", false, 500));
    const { fetchImpl: axelorFetchImpl, pushCalls } = trackingAxelorFetch(800);

    const deps: MigrationEngineDeps = {
      db,
      leadsConfig: leadsConfig(leadsFetchImpl as unknown as typeof fetch),
      axelorConfig: axelorConfig(),
      pageLimit: 100,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
      countries: ["NI"],
    };

    const summary = await runMigration(deps);

    expect(summary.countries[0]?.status).toBe("failed");
    expect(pushCalls).toHaveLength(0);
  });

  it("records a visibility-only import_errors row when the AiSearch progress push fails twice, without affecting the run's own outcome", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "ACME" })));

    const axelorFetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(".AiSearch")) {
        return jsonResponse({ status: 0, data: [{ id: 100 }] });
      }
      // Both the GET and the retried GET inside pushAiSearchUpdate hit this
      // branch and fail, so the whole push fails twice.
      if (url.endsWith(".AiSearch/100")) {
        throw new Error("axelor unreachable");
      }
      return jsonResponse({ status: 0, data: [{ id: 200 }] });
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

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
    errorSpy.mockRestore();

    // The migration itself is unaffected by the push failure: the record
    // saved fine, and the country still completes normally.
    const countrySummary = summary.countries.find((c) => c.countryCode === "AR");
    expect(countrySummary?.processedCount).toBe(1);
    expect(countrySummary?.failedCount).toBe(0);
    expect(countrySummary?.status).toBe("completed");

    const errors = db.prepare(`SELECT * FROM import_errors WHERE country_code = 'AR'`).all() as {
      error_reason: string;
      record_offset: number | null;
    }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.record_offset).toBeNull();
    expect(errors[0]?.error_reason).toMatch(/AiSearch progress sync failed/);
    expect(errors[0]?.error_reason).toMatch(/aiSearchId=100/);
  });

  it("resolves the checkpoint to 'failed' (never stuck at 'running') when a dependency in the pre-loop setup gap throws", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    // Simulates a failure in the gap between the checkpoint being marked
    // 'running' and the page loop actually starting (e.g. lock contention or
    // schema drift on the field_mappings lookup) — the exact regression this
    // test guards against: before the Fix 1 restructuring, nothing caught an
    // exception thrown here, and the checkpoint was left reading 'running'
    // forever with nothing left to process it.
    vi.mocked(listFieldMappings).mockImplementationOnce(() => {
      throw new Error("field_mappings lookup failed");
    });

    const leadsFetchImpl = vi.fn();
    const axelorFetchImpl = vi.fn();

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

    // The exception was caught before the page loop ever ran — the Leads DB
    // was never even reached.
    expect(leadsFetchImpl).not.toHaveBeenCalled();

    const countrySummary = summary.countries.find((c) => c.countryCode === "AR");
    expect(countrySummary?.status).toBe("failed");
    expect(countrySummary?.halted).toBe(false);

    const checkpoint = getByRunCountry(db, summary.runId, "AR");
    expect(checkpoint?.status).toBe("failed");

    const errors = db.prepare(`SELECT * FROM import_errors WHERE country_code = 'AR'`).all() as {
      error_reason: string;
      record_offset: number | null;
    }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.record_offset).toBeNull();
    expect(errors[0]?.error_reason).toMatch(/field_mappings lookup failed/);
  });

  it("increments daily_save_stats for the day a record is successfully saved", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "ACME" })));

    const { fetchImpl: axelorFetchImpl } = trackingAxelorFetch(900);

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

    const today = new Date().toISOString().slice(0, 10);
    expect(getSavedCountsByDay(db)).toEqual([{ day: today, count: 1 }]);
  });

  it("counts a record as saved (never failed) when incrementSavedCount itself throws, and records no phantom import_errors row for it", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR"]);
    seedTitleMapping(db, "AR");

    vi.mocked(incrementSavedCount).mockImplementationOnce(() => {
      throw new Error("daily_save_stats table missing (stale DB copy)");
    });

    const leadsFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(jsonLine({ legal_name: "ACME" })));

    const { fetchImpl: axelorFetchImpl } = trackingAxelorFetch(901);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

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
    errorSpy.mockRestore();

    // The record itself saved fine — a telemetry-write failure on top of it
    // must never be misread as a failed save.
    const countrySummary = summary.countries.find((c) => c.countryCode === "AR");
    expect(countrySummary?.processedCount).toBe(1);
    expect(countrySummary?.failedCount).toBe(0);
    expect(countrySummary?.status).toBe("completed");
    expect(countrySummary?.halted).toBe(false);

    const errors = db.prepare(`SELECT * FROM import_errors WHERE country_code = 'AR'`).all();
    expect(errors).toHaveLength(0);
  });
});
