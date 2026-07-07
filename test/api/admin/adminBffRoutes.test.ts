import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../../src/db/migrate.js";
import { buildServer } from "../../../src/api/server.js";
import { upsertFieldMapping } from "../../../src/repos/mappingRepo.js";
import type { AuthConfig } from "../../../src/api/auth/authGuard.js";
import type { MigrationControlDeps } from "../../../src/api/routes/migrationControl.js";
import type { AxelorConfig } from "../../../src/config/env.js";
import type { LeadsClientConfig } from "../../../src/leads/leadsClient.js";
import type { AxelorSessionClient } from "../../../src/axelor/sessionClient.js";
import type { MigrationEngineDeps, MigrationSummary } from "../../../src/migration/engine.js";
import { createRun, updateRunStatus } from "../../../src/db/runsRepo.js";
import { advanceOffset, setAiSearchId, upsertCheckpoint } from "../../../src/db/checkpointRepo.js";
import { markResolved, recordError } from "../../../src/db/importErrorRepo.js";

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
    expect(response.json().data).toEqual({ run: null, checkpoints: [], totals: { errors: 0 } });
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
