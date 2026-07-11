import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { Writable } from "node:stream";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { migrate } from "../../../src/db/migrate.js";
import { buildServer } from "../../../src/api/server.js";
import { adminPlugin } from "../../../src/api/admin/adminPlugin.js";
import { upsertFieldMapping } from "../../../src/repos/mappingRepo.js";
import type { AuthConfig } from "../../../src/api/auth/authGuard.js";
import type { MigrationControlDeps } from "../../../src/api/routes/migrationControl.js";
import type { AxelorConfig } from "../../../src/config/env.js";
import type { LeadsClientConfig } from "../../../src/leads/leadsClient.js";
import type { AxelorSessionClient } from "../../../src/axelor/sessionClient.js";
import type { MigrationEngineDeps, MigrationSummary } from "../../../src/migration/engine.js";
import { createMigrationController } from "../../../src/migration/controller.js";
import { createRun, updateRunStatus } from "../../../src/db/runsRepo.js";
import { advanceOffset, setAiSearchId, upsertCheckpoint } from "../../../src/db/checkpointRepo.js";
import { markResolved, recordError } from "../../../src/db/importErrorRepo.js";
import { incrementSavedCount } from "../../../src/db/dailySaveStatsRepo.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

const authConfig: AuthConfig = {
  username: "admin",
  password: "s3cret",
  internalApiKey: "internal-key-123",
};

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function apiHeaders(): Record<string, string> {
  return {
    authorization: basicAuthHeader(authConfig.username, authConfig.password),
    "x-internal-api-key": authConfig.internalApiKey,
  };
}

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
    getSession: async () => ({ authHeader: "Basic xyz", cookieHeader: "JSESSIONID=abc" }),
    invalidate: () => {},
  };
}

function fakeMigrationDeps(db: Database.Database): MigrationControlDeps {
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

function setCookieHeader(response: { headers: Record<string, unknown> }): string | undefined {
  const raw = response.headers["set-cookie"];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw.join("; ") : String(raw);
}

async function adminLoginCookie(server: {
  inject: (opts: unknown) => Promise<{ headers: Record<string, unknown> }>;
}): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/admin/login",
    payload: { username: authConfig.username, password: authConfig.password },
  });
  const cookie = setCookieHeader(response);
  if (cookie === undefined) {
    throw new Error("admin login did not set a session cookie");
  }
  return cookie;
}

function adminGetHeaders(cookie: string): Record<string, string> {
  return { cookie };
}

function adminMutateHeaders(cookie: string): Record<string, string> {
  return { cookie, "x-requested-with": "fetch" };
}

function seededFieldMappingsDb(): Database.Database {
  const db = freshDb();
  upsertFieldMapping(db, {
    sourceDb: "ar",
    sourceTable: "companies",
    sourceColumn: "legal_name",
    destinationDomain: "AiSearchResults",
    destinationField: "title",
    additionalInfoKey: null,
    confidence: "high",
    note: null,
    origin: "bootstrap",
  });
  return db;
}

describe("GET /admin/api/status", () => {
  it("returns a null-run indicator with 200 when no run has ever started", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/status",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      run: null,
      checkpoints: [],
      totals: { errors: 0 },
      axelorBaseUrl: "http://axelor.example.test",
    });
  });

  it("returns the exact same payload as /api/migration/status for an active run", async () => {
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
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const apiResponse = await server.inject({
      method: "GET",
      url: "/api/migration/status",
      headers: apiHeaders(),
    });
    const adminResponse = await server.inject({
      method: "GET",
      url: "/admin/api/status",
      headers: adminGetHeaders(cookie),
    });

    expect(adminResponse.statusCode).toBe(200);
    expect(adminResponse.json().data).toEqual(apiResponse.json().data);
  });

  it("rejects requests without an authenticated session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({ method: "GET", url: "/admin/api/status" });

    expect(response.statusCode).toBe(401);
  });
});

describe("/admin/api/field-mappings", () => {
  it("lists all field mappings when no filter is given", async () => {
    const db = seededFieldMappingsDb();
    const server = buildServer({ db, authConfig });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/field-mappings",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });

  it("filters the list by source_db and source_table query params", async () => {
    const db = seededFieldMappingsDb();
    upsertFieldMapping(db, {
      sourceDb: "cl",
      sourceTable: "companies",
      sourceColumn: "razon_social",
      destinationDomain: "AiSearchResults",
      destinationField: "title",
      additionalInfoKey: null,
      confidence: "high",
      note: null,
      origin: "bootstrap",
    });
    const server = buildServer({ db, authConfig });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/field-mappings?source_db=cl&source_table=companies",
      headers: adminGetHeaders(cookie),
    });

    const body = response.json().data;
    expect(body).toHaveLength(1);
    expect(body[0].sourceDb).toBe("cl");
  });

  it("returns 404 reading a nonexistent id", async () => {
    const db = seededFieldMappingsDb();
    const server = buildServer({ db, authConfig });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/field-mappings/999999",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(404);
  });

  it("updates destinationField and forces origin to admin", async () => {
    const db = seededFieldMappingsDb();
    const server = buildServer({ db, authConfig });
    const cookie = await adminLoginCookie(server);
    const row = db.prepare(`SELECT id FROM field_mappings LIMIT 1`).get() as { id: number };

    const response = await server.inject({
      method: "PUT",
      url: `/admin/api/field-mappings/${row.id}`,
      headers: adminMutateHeaders(cookie),
      payload: { destinationField: "additionalInfo" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.destinationField).toBe("additionalInfo");
    expect(body.origin).toBe("admin");
  });

  it("returns 404 updating a nonexistent id", async () => {
    const db = seededFieldMappingsDb();
    const server = buildServer({ db, authConfig });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "PUT",
      url: "/admin/api/field-mappings/999999",
      headers: adminMutateHeaders(cookie),
      payload: { destinationField: "title" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects list requests without an authenticated session", async () => {
    const db = seededFieldMappingsDb();
    const server = buildServer({ db, authConfig });

    const response = await server.inject({ method: "GET", url: "/admin/api/field-mappings" });

    expect(response.statusCode).toBe(401);
  });

  it("rejects an update missing the CSRF header even with a valid session", async () => {
    const db = seededFieldMappingsDb();
    const server = buildServer({ db, authConfig });
    const cookie = await adminLoginCookie(server);
    const row = db.prepare(`SELECT id FROM field_mappings LIMIT 1`).get() as { id: number };

    const response = await server.inject({
      method: "PUT",
      url: `/admin/api/field-mappings/${row.id}`,
      headers: { cookie },
      payload: { destinationField: "title" },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("GET /admin/api/catalog", () => {
  it("lists source_catalog rows ordered by source_db", async () => {
    const db = freshDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO source_catalog (source_db, source_table, country_code, last_sampled_at, sampled_row_count)
       VALUES ('cl', 'companies', 'cl', ?, 10)`,
    ).run(now);
    db.prepare(
      `INSERT INTO source_catalog (source_db, source_table, country_code, last_sampled_at, sampled_row_count)
       VALUES ('ar', 'companies', NULL, NULL, NULL)`,
    ).run();
    const server = buildServer({ db, authConfig });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/catalog",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body).toHaveLength(2);
    expect(body.map((row: { sourceDb: string }) => row.sourceDb)).toEqual(["ar", "cl"]);
    expect(body[0].countryCode).toBeNull();
  });

  it("rejects requests without an authenticated session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig });

    const response = await server.inject({ method: "GET", url: "/admin/api/catalog" });

    expect(response.statusCode).toBe(401);
  });
});

describe("GET /admin/api/errors", () => {
  it("lists import_errors filtered by runId/countryCode/resolved", async () => {
    const db = freshDb();
    const run = createRun(db);
    const unresolved = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 10,
      recordIdentifier: "ACME",
      errorReason: "boom",
    });
    const resolvedRow = recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 20,
      recordIdentifier: "OTHER",
      errorReason: "kaboom",
    });
    markResolved(db, resolvedRow.id);
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: `/admin/api/errors?runId=${run.id}&resolved=false`,
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(unresolved.id);
  });

  it("rejects requests without an authenticated session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({ method: "GET", url: "/admin/api/errors" });

    expect(response.statusCode).toBe(401);
  });

  it("returns a page via limit/offset alongside the total matching count", async () => {
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
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: `/admin/api/errors?runId=${run.id}&limit=2&offset=2`,
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  it("returns everything when limit/offset are omitted (backward compat)", async () => {
    const db = freshDb();
    const run = createRun(db);
    for (let i = 0; i < 3; i++) {
      recordError(db, {
        runId: run.id,
        countryCode: "ar",
        recordOffset: i,
        recordIdentifier: null,
        errorReason: `boom-${i}`,
      });
    }
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: `/admin/api/errors?runId=${run.id}`,
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(3);
    expect(body.total).toBe(3);
  });

  it("returns 400 for a limit over 200", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/errors?limit=201",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for a negative offset", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/errors?offset=-1",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /admin/api/errors/analytics", () => {
  it("returns the whole-table day/hour error breakdown, ignoring runId/countryCode/resolved", async () => {
    const db = freshDb();
    const run = createRun(db);
    const first = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-1",
    });
    const second = recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-2",
    });
    markResolved(db, second.id);
    db.prepare(`UPDATE import_errors SET created_at = ? WHERE id = ?`).run(
      "2026-07-08T14:05:00.000Z",
      first.id,
    );
    db.prepare(`UPDATE import_errors SET created_at = ? WHERE id = ?`).run(
      "2026-07-08T14:55:00.000Z",
      second.id,
    );
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/errors/analytics",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [{ day: "2026-07-08", hour: "14", count: 2, percentage: 100 }],
    });
  });

  it("rejects requests without an authenticated session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({ method: "GET", url: "/admin/api/errors/analytics" });

    expect(response.statusCode).toBe(401);
  });

  it("forwards ?day to the controller, scoping the result and its percentage to that day", async () => {
    const db = freshDb();
    const run = createRun(db);
    const targetDay = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-target",
    });
    const otherDay1 = recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-other-1",
    });
    const otherDay2 = recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 3,
      recordIdentifier: null,
      errorReason: "boom-other-2",
    });
    db.prepare(`UPDATE import_errors SET created_at = ? WHERE id = ?`).run(
      "2026-07-08T09:00:00.000Z",
      targetDay.id,
    );
    db.prepare(`UPDATE import_errors SET created_at = ? WHERE id = ?`).run(
      "2026-07-09T01:00:00.000Z",
      otherDay1.id,
    );
    db.prepare(`UPDATE import_errors SET created_at = ? WHERE id = ?`).run(
      "2026-07-09T02:00:00.000Z",
      otherDay2.id,
    );
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/errors/analytics?day=2026-07-08",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    // If percentage were still computed against the whole table (3 rows
    // across both days), this would read 33.3% instead of 100%.
    expect(response.json()).toEqual({
      data: [{ day: "2026-07-08", hour: "09", count: 1, percentage: 100 }],
    });
  });

  it("returns 400 for an invalid ?day format", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/errors/analytics?day=not-a-date",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(400);
  });

  it("still works when ?day is omitted (backward compatible whole-table view)", async () => {
    const db = freshDb();
    const run = createRun(db);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom",
    });
    db.prepare(`UPDATE import_errors SET created_at = ? WHERE id = ?`).run(
      "2026-07-08T09:00:00.000Z",
      error.id,
    );
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/errors/analytics",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [{ day: "2026-07-08", hour: "09", count: 1, percentage: 100 }],
    });
  });
});

describe("GET /admin/api/analytics/daily", () => {
  it("returns saved-vs-error counts by day, defaulting to granularity=day and limit=14", async () => {
    const db = freshDb();
    const run = createRun(db);
    incrementSavedCount(db, "2026-07-08");
    incrementSavedCount(db, "2026-07-08");
    const error = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom",
    });
    db.prepare(`UPDATE import_errors SET created_at = ? WHERE id = ?`).run(
      "2026-07-09T09:00:00.000Z",
      error.id,
    );
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/analytics/daily",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        { period: "2026-07-08", saved: 2, error: 0 },
        { period: "2026-07-09", saved: 0, error: 1 },
      ],
    });
  });

  it("buckets by ISO week when granularity=week", async () => {
    const db = freshDb();
    // 2026-07-06 is a Monday; 2026-07-08 falls in that same ISO week.
    incrementSavedCount(db, "2026-07-06");
    incrementSavedCount(db, "2026-07-08");
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/analytics/daily?granularity=week",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [{ period: "2026-07-06", saved: 2, error: 0 }] });
  });

  it("respects an explicit limit", async () => {
    const db = freshDb();
    incrementSavedCount(db, "2026-07-01");
    incrementSavedCount(db, "2026-07-02");
    incrementSavedCount(db, "2026-07-03");
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/analytics/daily?limit=2",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        { period: "2026-07-02", saved: 1, error: 0 },
        { period: "2026-07-03", saved: 1, error: 0 },
      ],
    });
  });

  it("returns 400 for an invalid granularity", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/analytics/daily?granularity=month",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 when limit exceeds the max of 90", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/analytics/daily?limit=91",
      headers: adminGetHeaders(cookie),
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects requests without an authenticated session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({ method: "GET", url: "/admin/api/analytics/daily" });

    expect(response.statusCode).toBe(401);
  });
});

describe("POST /admin/api/errors/:id/retry", () => {
  it("returns 404 for a nonexistent error id", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/errors/999999/retry",
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 409 for an already-resolved error", async () => {
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
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: `/admin/api/errors/${errorRow.id}/retry`,
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(409);
  });

  it("returns 200 with resolved=true when the retry succeeds", async () => {
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

    const leadsFetchImpl = async () => textResponse(`{"legal_name":"ACME"}`);
    const axelorFetchImpl = async () => jsonResponse({ status: 0, data: [{ id: 555 }] });
    const deps: MigrationControlDeps = {
      db,
      leadsConfig: { ...fakeLeadsConfig(), fetchImpl: leadsFetchImpl as unknown as typeof fetch },
      axelorConfig: fakeAxelorConfig(),
      pageLimit: 100,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };
    const server = buildServer({ db, authConfig, migrationDeps: deps });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: `/admin/api/errors/${errorRow.id}/retry`,
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.outcome).toBe("resolved");
    expect(body.importError.resolved).toBe(true);
  });

  it("returns 422 with the failure reason when the retry fails again", async () => {
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
      errorReason: "first failure",
    });

    const leadsFetchImpl = async () => textResponse(`{"legal_name":"ACME"}`);
    const axelorFetchImpl = async () => jsonResponse({ status: 1, data: [] }, true);
    const deps: MigrationControlDeps = {
      db,
      leadsConfig: { ...fakeLeadsConfig(), fetchImpl: leadsFetchImpl as unknown as typeof fetch },
      axelorConfig: fakeAxelorConfig(),
      pageLimit: 100,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };
    const server = buildServer({ db, authConfig, migrationDeps: deps });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: `/admin/api/errors/${errorRow.id}/retry`,
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(422);
    const body = response.json().data;
    expect(body.outcome).toBe("failed");
    expect(body.importError.resolved).toBe(false);
  });

  it("rejects a retry without an authenticated session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({ method: "POST", url: "/admin/api/errors/1/retry" });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a retry missing the CSRF header even with a valid session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/errors/1/retry",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("POST /admin/api/errors/retry-bulk", () => {
  it("returns 200 with a summary when the bulk retry completes", async () => {
    const db = freshDb();
    seedTitleMapping(db, "AR");
    const run = createRun(db);
    updateRunStatus(db, run.id, "stopped");
    const checkpoint = upsertCheckpoint(db, run.id, "AR");
    setAiSearchId(db, checkpoint.id, 999);
    recordError(db, {
      runId: run.id,
      countryCode: "AR",
      recordOffset: 5,
      recordIdentifier: "ACME",
      errorReason: "boom",
    });

    const leadsFetchImpl = async () => textResponse(`{"legal_name":"ACME"}`);
    const axelorFetchImpl = async () => jsonResponse({ status: 0, data: [{ id: 555 }] });
    const deps: MigrationControlDeps = {
      db,
      leadsConfig: { ...fakeLeadsConfig(), fetchImpl: leadsFetchImpl as unknown as typeof fetch },
      axelorConfig: fakeAxelorConfig(),
      pageLimit: 100,
      session: fakeSession(),
      fetchImpl: axelorFetchImpl as unknown as typeof fetch,
    };
    const server = buildServer({ db, authConfig, migrationDeps: deps });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/errors/retry-bulk",
      headers: adminMutateHeaders(cookie),
      payload: { runId: run.id },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body).toEqual({
      totalMatched: 1,
      processedCount: 1,
      resolvedCount: 1,
      failedCount: 0,
      skippedCount: 0,
      blockSize: 20,
      blockCount: 1,
    });
  });

  it("returns 409 with the conflictError shape when a migration run is active", async () => {
    const db = freshDb();
    createRun(db); // createRun defaults to status='running', i.e. active.
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/errors/retry-bulk",
      headers: adminMutateHeaders(cookie),
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("conflict");
  });

  it("returns 400 for an invalid body (runId not a positive number)", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/errors/retry-bulk",
      headers: adminMutateHeaders(cookie),
      payload: { runId: -1 },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for an empty-string countryCode", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/errors/retry-bulk",
      headers: adminMutateHeaders(cookie),
      payload: { countryCode: "" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("rejects a bulk retry without an authenticated session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/errors/retry-bulk",
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a bulk retry missing the CSRF header even with a valid session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/errors/retry-bulk",
      headers: { cookie },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("POST /admin/api/migration/{start,pause,resume,stop}", () => {
  it("starts a new run and 202s", async () => {
    const db = freshDb();
    const server = buildServer({
      db,
      authConfig,
      migrationDeps: fakeMigrationDeps(db),
      runMigrationFn: resolvedRunMigrationFn(),
    });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/migration/start",
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data.status).toBe("running");
    await flushMicrotasks();
  });

  it("returns 409 starting when a run is already active", async () => {
    const db = freshDb();
    createRun(db);
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/migration/start",
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(409);
  });

  it("pauses a running run", async () => {
    const db = freshDb();
    createRun(db);
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/migration/pause",
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("paused");
  });

  it("resumes a paused run", async () => {
    const db = freshDb();
    const run = createRun(db);
    updateRunStatus(db, run.id, "paused");
    const server = buildServer({
      db,
      authConfig,
      migrationDeps: fakeMigrationDeps(db),
      runMigrationFn: resolvedRunMigrationFn(),
    });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/migration/resume",
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data.status).toBe("running");
    await flushMicrotasks();
  });

  it("stops an active run", async () => {
    const db = freshDb();
    createRun(db);
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/migration/stop",
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("stopped");
  });

  it("rejects a start without an authenticated session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({ method: "POST", url: "/admin/api/migration/start" });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a start missing the CSRF header even with a valid session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/migration/start",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("POST /admin/api/migration/countries/:countryCode/retry", () => {
  it("returns 200 with the new run when the retry starts", async () => {
    const db = freshDb();
    const priorRun = createRun(db);
    updateRunStatus(db, priorRun.id, "stopped");
    upsertCheckpoint(db, priorRun.id, "AR");
    const server = buildServer({
      db,
      authConfig,
      migrationDeps: fakeMigrationDeps(db),
      runMigrationFn: resolvedRunMigrationFn(),
    });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/migration/countries/AR/retry",
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("running");
    await flushMicrotasks();
  });

  it("returns 404 for a country with no checkpoint history", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/migration/countries/ZZ/retry",
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });

  it("returns 409 when a migration run is already active", async () => {
    const db = freshDb();
    const priorRun = createRun(db);
    updateRunStatus(db, priorRun.id, "stopped");
    upsertCheckpoint(db, priorRun.id, "AR");
    createRun(db); // defaults to status='running', i.e. active.
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/migration/countries/AR/retry",
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("conflict");
  });

  it("rejects a retry without an authenticated session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/migration/countries/AR/retry",
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a retry missing the CSRF header even with a valid session", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/migration/countries/AR/retry",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("POST /admin/api/catalog/refresh", () => {
  function fakeRefreshLeadsConfig(): LeadsClientConfig {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ countries: { AR: {}, CO: {} }, databases: {} }),
      text: async () => JSON.stringify({ countries: { AR: {}, CO: {} }, databases: {} }),
    });
    return {
      ...fakeLeadsConfig(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
  }

  it("refreshes the catalog and returns the result with 200", async () => {
    const db = freshDb();
    const deps: MigrationControlDeps = { ...fakeMigrationDeps(db), leadsConfig: fakeRefreshLeadsConfig() };
    const server = buildServer({ db, authConfig, migrationDeps: deps });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/catalog/refresh",
      headers: adminMutateHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.totalCatalogEntries).toBe(2);
    expect(body.newPairs).toEqual([
      { sourceDb: "AR", sourceTable: "companies" },
      { sourceDb: "CO", sourceTable: "companies" },
    ]);
  });

  it("rejects a refresh without an authenticated session", async () => {
    const db = freshDb();
    const deps: MigrationControlDeps = { ...fakeMigrationDeps(db), leadsConfig: fakeRefreshLeadsConfig() };
    const server = buildServer({ db, authConfig, migrationDeps: deps });

    const response = await server.inject({ method: "POST", url: "/admin/api/catalog/refresh" });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a refresh missing the CSRF header even with a valid session", async () => {
    const db = freshDb();
    const deps: MigrationControlDeps = { ...fakeMigrationDeps(db), leadsConfig: fakeRefreshLeadsConfig() };
    const server = buildServer({ db, authConfig, migrationDeps: deps });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/catalog/refresh",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("POST /admin/api/reset", () => {
  function fakeResetLeadsConfig(): LeadsClientConfig {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ countries: { AR: {}, CO: {} }, databases: {} }),
      text: async () => JSON.stringify({ countries: { AR: {}, CO: {} }, databases: {} }),
    });
    return {
      ...fakeLeadsConfig(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
  }

  it("wipes every operational table and reseeds mappings + catalog on the correct password", async () => {
    const db = freshDb();
    const run = createRun(db);
    // Stopped, not active: this test exercises the wipe/reseed path itself,
    // not the active-run guard (covered separately below).
    updateRunStatus(db, run.id, "stopped");
    upsertCheckpoint(db, run.id, "AR");
    recordError(db, {
      runId: run.id,
      countryCode: "AR",
      recordOffset: 1,
      recordIdentifier: "ACME",
      errorReason: "boom",
    });
    upsertFieldMapping(db, {
      sourceDb: "ar",
      sourceTable: "companies",
      sourceColumn: "legal_name",
      destinationDomain: "AiSearchResults",
      destinationField: "title",
      additionalInfoKey: null,
      confidence: "high",
      note: null,
      origin: "admin",
    });
    const deps: MigrationControlDeps = { ...fakeMigrationDeps(db), leadsConfig: fakeResetLeadsConfig() };
    const server = buildServer({ db, authConfig, migrationDeps: deps });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/reset",
      headers: adminMutateHeaders(cookie),
      payload: { password: authConfig.password },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.catalog.totalCatalogEntries).toBe(2);
    expect(body.seed.totalRows).toBeGreaterThan(0);

    const runsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM migration_runs`).get() as { count: number }
    ).count;
    const checkpointsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM migration_checkpoints`).get() as { count: number }
    ).count;
    const errorsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM import_errors`).get() as { count: number }
    ).count;
    expect(runsCount).toBe(0);
    expect(checkpointsCount).toBe(0);
    expect(errorsCount).toBe(0);

    // The admin-edited row from before the reset is gone: field_mappings was
    // wiped and reseeded from scratch, not selectively updated.
    const adminOriginCount = (
      db.prepare(`SELECT COUNT(*) as count FROM field_mappings WHERE origin = 'admin'`).get() as {
        count: number;
      }
    ).count;
    expect(adminOriginCount).toBe(0);

    const catalogRows = db.prepare(`SELECT source_db FROM source_catalog ORDER BY source_db`).all();
    expect(catalogRows).toEqual([{ source_db: "AR" }, { source_db: "CO" }]);
  });

  it("returns 403 and wipes nothing on the wrong password", async () => {
    // 403, not 401: a 401 here would be intercepted by `adminFetch`'s
    // blanket 401-to-login-redirect handling in app.js before the
    // "Incorrect password." message could ever be shown (see fix #3).
    const db = freshDb();
    createRun(db);
    const deps: MigrationControlDeps = { ...fakeMigrationDeps(db), leadsConfig: fakeResetLeadsConfig() };
    const server = buildServer({ db, authConfig, migrationDeps: deps });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/reset",
      headers: adminMutateHeaders(cookie),
      payload: { password: "wrong-password" },
    });

    expect(response.statusCode).toBe(403);
    const runsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM migration_runs`).get() as { count: number }
    ).count;
    expect(runsCount).toBe(1);
  });

  it("returns 403 (not 401) and wipes nothing for a shorter incorrect password", async () => {
    // Exercises timingSafeEqual's length-mismatch path (fix #5): must not
    // throw, and must correctly report "not equal".
    const db = freshDb();
    createRun(db);
    const deps: MigrationControlDeps = { ...fakeMigrationDeps(db), leadsConfig: fakeResetLeadsConfig() };
    const server = buildServer({ db, authConfig, migrationDeps: deps });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/reset",
      headers: adminMutateHeaders(cookie),
      payload: { password: "x" },
    });

    expect(response.statusCode).toBe(403);
    const runsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM migration_runs`).get() as { count: number }
    ).count;
    expect(runsCount).toBe(1);
  });

  it("returns 403 on a malformed body (missing password / extra field)", async () => {
    const db = freshDb();
    const deps: MigrationControlDeps = { ...fakeMigrationDeps(db), leadsConfig: fakeResetLeadsConfig() };
    const server = buildServer({ db, authConfig, migrationDeps: deps });
    const cookie = await adminLoginCookie(server);

    const missingPassword = await server.inject({
      method: "POST",
      url: "/admin/api/reset",
      headers: adminMutateHeaders(cookie),
      payload: {},
    });
    expect(missingPassword.statusCode).toBe(403);

    const extraField = await server.inject({
      method: "POST",
      url: "/admin/api/reset",
      headers: adminMutateHeaders(cookie),
      payload: { password: authConfig.password, extra: "nope" },
    });
    expect(extraField.statusCode).toBe(403);
  });

  it("returns 409 and wipes nothing when a migration run is currently active", async () => {
    const db = freshDb();
    createRun(db); // createRun defaults to status='running', i.e. active.
    upsertFieldMapping(db, {
      sourceDb: "ar",
      sourceTable: "companies",
      sourceColumn: "legal_name",
      destinationDomain: "AiSearchResults",
      destinationField: "title",
      additionalInfoKey: null,
      confidence: "high",
      note: null,
      origin: "bootstrap",
    });
    const deps: MigrationControlDeps = { ...fakeMigrationDeps(db), leadsConfig: fakeResetLeadsConfig() };
    const server = buildServer({ db, authConfig, migrationDeps: deps });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/reset",
      headers: adminMutateHeaders(cookie),
      payload: { password: authConfig.password },
    });

    expect(response.statusCode).toBe(409);
    const runsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM migration_runs`).get() as { count: number }
    ).count;
    const mappingsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM field_mappings`).get() as { count: number }
    ).count;
    expect(runsCount).toBe(1);
    expect(mappingsCount).toBeGreaterThan(0);
  });

  it("returns a properly-shaped 500 and logs an error when re-seeding fails after the wipe already committed", async () => {
    const db = freshDb();
    const run = createRun(db);
    upsertCheckpoint(db, run.id, "AR");
    // Stopped so the active-run guard (fix #1) doesn't reject before reaching
    // the reseed step this test targets.
    updateRunStatus(db, run.id, "stopped");

    const failingFetchImpl = vi.fn().mockRejectedValue(new Error("network unreachable"));
    const deps: MigrationControlDeps = {
      ...fakeMigrationDeps(db),
      leadsConfig: { ...fakeLeadsConfig(), fetchImpl: failingFetchImpl as unknown as typeof fetch },
    };
    const controller = createMigrationController(db, deps);

    // Built directly (not via buildServer, which silences its logger under
    // NODE_ENV=test) with a real pino logger writing to a capturable stream,
    // so the `request.log.error(...)` call this route makes on this failure
    // path is actually observable — this codebase has no error-tracking
    // integration, so that log line is the only production visibility this
    // failure will ever get.
    const logLines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });
    const fastify = Fastify({ logger: { stream, level: "error" } });
    await fastify.register(adminPlugin, { db, authConfig, controller });
    await fastify.ready();

    const cookie = await adminLoginCookie(fastify);
    const response = await fastify.inject({
      method: "POST",
      url: "/admin/api/reset",
      headers: adminMutateHeaders(cookie),
      payload: { password: authConfig.password },
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toContain("Reset wiped all tables successfully, but re-seeding failed");
    expect(body.error.message).toContain("network unreachable");

    // Documents the exact known degraded state: `runFullReset` wipes
    // everything, then runs `runSeed` (succeeds, since it depends only on
    // the committed local JSON dataset, not the network) before awaiting
    // `runRefreshCatalog` (fails, since `fetchImpl` rejects). So
    // field_mappings IS repopulated, but every other operational table is
    // left empty — this is the exact state the thrown error's message tells
    // the operator to recover from manually.
    const runsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM migration_runs`).get() as { count: number }
    ).count;
    const checkpointsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM migration_checkpoints`).get() as { count: number }
    ).count;
    const catalogCount = (
      db.prepare(`SELECT COUNT(*) as count FROM source_catalog`).get() as { count: number }
    ).count;
    const mappingsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM field_mappings`).get() as { count: number }
    ).count;
    expect(runsCount).toBe(0);
    expect(checkpointsCount).toBe(0);
    expect(catalogCount).toBe(0);
    expect(mappingsCount).toBeGreaterThan(0);

    const parsedLogLines = logLines
      .map((line) => JSON.parse(line) as { level: number; msg: string; err?: string });
    const errorLogLine = parsedLogLines.find((line) =>
      line.msg?.includes("admin reset failed after wiping operational tables"),
    );
    expect(errorLogLine).toBeDefined();
    expect(errorLogLine?.level).toBe(50); // pino's numeric "error" level
    expect(errorLogLine?.err).toContain("network unreachable");
  });

  it("rejects a reset without an authenticated session", async () => {
    const db = freshDb();
    const deps: MigrationControlDeps = { ...fakeMigrationDeps(db), leadsConfig: fakeResetLeadsConfig() };
    const server = buildServer({ db, authConfig, migrationDeps: deps });

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/reset",
      payload: { password: authConfig.password },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a reset missing the CSRF header even with a valid session", async () => {
    const db = freshDb();
    const deps: MigrationControlDeps = { ...fakeMigrationDeps(db), leadsConfig: fakeResetLeadsConfig() };
    const server = buildServer({ db, authConfig, migrationDeps: deps });
    const cookie = await adminLoginCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/reset",
      headers: { cookie },
      payload: { password: authConfig.password },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("cross-surface control consistency", () => {
  it("a run started via /api/migration/start can be paused via /admin/api/migration/pause, and both status endpoints agree", async () => {
    const db = freshDb();
    const server = buildServer({
      db,
      authConfig,
      migrationDeps: fakeMigrationDeps(db),
      runMigrationFn: resolvedRunMigrationFn(),
    });

    const startResponse = await server.inject({
      method: "POST",
      url: "/api/migration/start",
      headers: apiHeaders(),
    });
    expect(startResponse.statusCode).toBe(202);
    await flushMicrotasks();

    const cookie = await adminLoginCookie(server);
    const pauseResponse = await server.inject({
      method: "POST",
      url: "/admin/api/migration/pause",
      headers: adminMutateHeaders(cookie),
    });
    expect(pauseResponse.statusCode).toBe(200);
    expect(pauseResponse.json().data.status).toBe("paused");

    const apiStatus = await server.inject({
      method: "GET",
      url: "/api/migration/status",
      headers: apiHeaders(),
    });
    const adminStatus = await server.inject({
      method: "GET",
      url: "/admin/api/status",
      headers: adminGetHeaders(cookie),
    });

    expect(apiStatus.json().data.run.status).toBe("paused");
    expect(adminStatus.json().data).toEqual(apiStatus.json().data);
  });
});
